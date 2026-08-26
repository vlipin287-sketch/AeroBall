const express=require('express');
const path=require('path');
const crypto=require('crypto');
const Database=require('better-sqlite3');

const app=express();
const PORT=process.env.PORT||10000;
const db=new Database(path.join(__dirname,'aeroball.db'));
app.use(express.json({limit:'1mb'}));

const GAME_FILE=path.join(__dirname,'AeroBallFight-2.html');

const DEFAULT_PROFILE={
  fieldEffect:'grass',hudLayout:'both',graphicsQuality:'standard',
  items:{skin_blue:false,skin_red:false,ball_soccer:false,ball_puck:false,ball_beach:false,trail_paddle:false,trail_ball:false},
  equipped:{skin:'default',ball:'default',trail_paddle:false,trail_ball:false},
  redeemedPromos:[]
};

db.exec(`
CREATE TABLE IF NOT EXISTS users(
 username TEXT PRIMARY KEY,
 password_hash TEXT NOT NULL,
 elo INTEGER NOT NULL DEFAULT 1000,
 coins INTEGER NOT NULL DEFAULT 50,
 banned INTEGER NOT NULL DEFAULT 0,
 admin INTEGER NOT NULL DEFAULT 0,
 profile_json TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS promo_redemptions(
 username TEXT NOT NULL, code TEXT NOT NULL,
 redeemed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(username,code)
);
CREATE TABLE IF NOT EXISTS sessions(
 token TEXT PRIMARY KEY, username TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);
const cols=db.prepare(`PRAGMA table_info(users)`).all().map(x=>x.name);
if(!cols.includes('profile_json'))db.exec(`ALTER TABLE users ADD COLUMN profile_json TEXT NOT NULL DEFAULT '{}'`);

function hashPassword(p){return crypto.createHash('sha256').update(String(p)).digest('hex');}
function profileFor(u){
  let p={};try{p=JSON.parse(u.profile_json||'{}')}catch(e){}
  return Object.assign({},DEFAULT_PROFILE,p,{elo:u.elo,coins:u.coins});
}

const accounts=[['Artem','Art',0],['Vova','Vovik',0],['Miron','Miroha',0],['Sergey','Seryy',0],['Ilya','Iluha',0],['RAZRAB','S1GMA',1]];
for(const [n,p,a] of accounts){
  const u=db.prepare(`SELECT * FROM users WHERE username=?`).get(n);
  if(!u){
    db.prepare(`INSERT INTO users(username,password_hash,elo,coins,admin,profile_json) VALUES(?,?,?,?,?,?)`)
      .run(n,hashPassword(p),1000,50,a,JSON.stringify(DEFAULT_PROFILE));
  }else{
    db.prepare(`UPDATE users SET password_hash=?,admin=? WHERE username=?`).run(hashPassword(p),a,n);
    // Existing accounts from the old test server had 0 coins. Give them the intended starter 50 once.
    if(Number(u.coins)===0 && String(u.profile_json||'{}')==='{}')
      db.prepare(`UPDATE users SET coins=50 WHERE username=?`).run(n);
  }
}

const PROMOS={Get100r:100,RAZRAB:1000,WINNER:500};
function auth(req,res,next){
  const h=req.get('authorization')||'',token=h.startsWith('Bearer ')?h.slice(7):'';
  if(!token)return res.status(401).json({error:'Требуется вход'});
  const u=db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.username=s.username WHERE s.token=?`).get(token);
  if(!u)return res.status(401).json({error:'Сессия недействительна'});
  if(u.banned)return res.status(403).json({error:'Аккаунт заблокирован'});
  req.user=u;req.token=token;next();
}
function adminOnly(req,res,next){if(!req.user.admin)return res.status(403).json({error:'Недостаточно прав'});next();}

app.get('/',(req,res)=>res.sendFile(GAME_FILE));
app.get('/AeroBallFight-2.html',(req,res)=>res.sendFile(GAME_FILE));

app.post('/api/login',(req,res)=>{
  const {username,password}=req.body||{},u=db.prepare(`SELECT * FROM users WHERE username=?`).get(username);
  if(!u||u.password_hash!==hashPassword(password||''))return res.status(401).json({error:'Неверный ник или пароль'});
  if(u.banned)return res.status(403).json({error:'Аккаунт заблокирован'});
  const token=crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO sessions(token,username) VALUES(?,?)`).run(token,u.username);
  res.json({token,user:{username:u.username,elo:u.elo,coins:u.coins,admin:!!u.admin,profile:profileFor(u)}});
});

app.post('/api/logout',auth,(req,res)=>{db.prepare(`DELETE FROM sessions WHERE token=?`).run(req.token);res.json({ok:true});});
app.get('/api/me',auth,(req,res)=>{
  const u=db.prepare(`SELECT * FROM users WHERE username=?`).get(req.user.username);
  res.json({username:u.username,elo:u.elo,coins:u.coins,admin:!!u.admin,profile:profileFor(u)});
});

app.put('/api/profile',auth,(req,res)=>{
  const x=req.body||{};
  const safe={
    fieldEffect:['grass','snow','none'].includes(x.fieldEffect)?x.fieldEffect:'grass',
    hudLayout:['left','right','both'].includes(x.hudLayout)?x.hudLayout:'both',
    graphicsQuality:['minimus','standard','future'].includes(x.graphicsQuality)?x.graphicsQuality:'standard',
    items:x.items||DEFAULT_PROFILE.items,
    equipped:x.equipped||DEFAULT_PROFILE.equipped,
    redeemedPromos:Array.isArray(x.redeemedPromos)?x.redeemedPromos:[]
  };
  db.prepare(`UPDATE users SET profile_json=? WHERE username=?`).run(JSON.stringify(safe),req.user.username);
  const u=db.prepare(`SELECT * FROM users WHERE username=?`).get(req.user.username);
  res.json(profileFor(u));
});

app.post('/api/coins',auth,(req,res)=>{
  const delta=Number(req.body?.delta);
  if(!Number.isInteger(delta)||Math.abs(delta)>1000000)return res.status(400).json({error:'Некорректное изменение монет'});
  db.prepare(`UPDATE users SET coins=MAX(0,coins+?) WHERE username=?`).run(delta,req.user.username);
  res.json(db.prepare(`SELECT elo,coins FROM users WHERE username=?`).get(req.user.username));
});

app.post('/api/elo',auth,(req,res)=>{
  const delta=Number(req.body?.delta);
  if(!Number.isInteger(delta)||Math.abs(delta)>500)return res.status(400).json({error:'Некорректное изменение ELO'});
  db.prepare(`UPDATE users SET elo=MAX(0,elo+?) WHERE username=?`).run(delta,req.user.username);
  res.json(db.prepare(`SELECT elo,coins FROM users WHERE username=?`).get(req.user.username));
});

app.post('/api/promo',auth,(req,res)=>{
  const code=String(req.body?.code||'').trim(),reward=PROMOS[code];
  if(!reward)return res.status(400).json({error:'Промокод не найден'});
  try{db.transaction(()=>{
    db.prepare(`INSERT INTO promo_redemptions(username,code) VALUES(?,?)`).run(req.user.username,code);
    db.prepare(`UPDATE users SET coins=coins+? WHERE username=?`).run(reward,req.user.username);
  })();}catch(e){return res.status(409).json({error:'Этот промокод уже активирован на аккаунте'});}
  const u=db.prepare(`SELECT elo,coins FROM users WHERE username=?`).get(req.user.username);
  res.json({reward,elo:u.elo,coins:u.coins});
});

app.get('/api/users',auth,adminOnly,(req,res)=>{
  res.json(db.prepare(`SELECT username,elo,coins,banned,admin,created_at FROM users ORDER BY elo DESC,username ASC`).all()
    .map(x=>({...x,banned:!!x.banned,admin:!!x.admin})));
});

app.post('/api/admin/coins',auth,adminOnly,(req,res)=>{
  const username=req.body?.username,delta=Number(req.body?.delta);
  if(!Number.isInteger(delta)||Math.abs(delta)>1000000)return res.status(400).json({error:'Некорректное изменение монет'});
  if(!db.prepare(`SELECT username FROM users WHERE username=?`).get(username))return res.status(404).json({error:'Аккаунт не найден'});
  db.prepare(`UPDATE users SET coins=MAX(0,coins+?) WHERE username=?`).run(delta,username);
  res.json(db.prepare(`SELECT username,elo,coins,banned FROM users WHERE username=?`).get(username));
});

app.post('/api/admin/ban',auth,adminOnly,(req,res)=>{
  const username=req.body?.username,banned=!!req.body?.banned;
  if(username==='RAZRAB')return res.status(400).json({error:'RAZRAB нельзя заблокировать'});
  if(!db.prepare(`SELECT username FROM users WHERE username=?`).get(username))return res.status(404).json({error:'Аккаунт не найден'});
  db.prepare(`UPDATE users SET banned=? WHERE username=?`).run(banned?1:0,username);
  if(banned)db.prepare(`DELETE FROM sessions WHERE username=?`).run(username);
  res.json({ok:true,username,banned});
});

app.get('/api/leaderboard',auth,(req,res)=>{
  res.json(db.prepare(`SELECT username,elo,coins FROM users WHERE banned=0 ORDER BY elo DESC,coins DESC`).all());
});

app.listen(PORT,'0.0.0.0',()=>console.log(`AeroBall server listening on ${PORT}`));
