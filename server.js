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
  items:{skin_blue:false,skin_red:false,ball_soccer:false,ball_puck:false,ball_beach:false,trail_paddle:false,trail_ball:false,theme_neon:false,theme_ice:false,final_theme_exclusive:false},
  equipped:{skin:'default',ball:'default',trail_paddle:false,trail_ball:false,menuTheme:'default',finalTheme:'default'},
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
const ADMIN_ONLY_ITEMS=['final_theme_exclusive']; // такие поля клиент не может выставить сам через /api/profile
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
app.use('/audio', express.static(path.join(__dirname,'audio')));
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
  const currentProfile=profileFor(req.user); // текущее состояние на сервере — источник правды для защищённых полей
  const items=Object.assign({},DEFAULT_PROFILE.items,x.items||{});
  ADMIN_ONLY_ITEMS.forEach(k=>{ items[k]=!!currentProfile.items[k]; }); // клиент не может сам себе выдать эксклюзив
  const equipped=Object.assign({},DEFAULT_PROFILE.equipped,x.equipped||{});
  if(equipped.finalTheme==='exclusive' && !items.final_theme_exclusive) equipped.finalTheme='default'; // нельзя выбрать невыданный трек
  const safe={
    fieldEffect:['grass','snow','none'].includes(x.fieldEffect)?x.fieldEffect:'grass',
    hudLayout:['left','right','both'].includes(x.hudLayout)?x.hudLayout:'both',
    graphicsQuality:['minimus','standard','future'].includes(x.graphicsQuality)?x.graphicsQuality:'standard',
    items,equipped,
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
  res.json(db.prepare(`SELECT username,elo,coins,banned,admin,profile_json,created_at FROM users ORDER BY elo DESC,username ASC`).all()
    .map(x=>{
      let items={}; try{items=JSON.parse(x.profile_json||'{}').items||{};}catch(e){}
      return {username:x.username,elo:x.elo,coins:x.coins,banned:!!x.banned,admin:!!x.admin,created_at:x.created_at,hasFinalExclusive:!!items.final_theme_exclusive};
    }));
});

app.post('/api/admin/coins',auth,adminOnly,(req,res)=>{
  const username=req.body?.username,delta=Number(req.body?.delta);
  if(!Number.isInteger(delta)||Math.abs(delta)>1000000)return res.status(400).json({error:'Некорректное изменение монет'});
  if(!db.prepare(`SELECT username FROM users WHERE username=?`).get(username))return res.status(404).json({error:'Аккаунт не найден'});
  db.prepare(`UPDATE users SET coins=MAX(0,coins+?) WHERE username=?`).run(delta,username);
  res.json(db.prepare(`SELECT username,elo,coins,banned FROM users WHERE username=?`).get(username));
});

app.post('/api/admin/elo',auth,adminOnly,(req,res)=>{
  const username=req.body?.username,delta=Number(req.body?.delta);
  if(!Number.isInteger(delta)||Math.abs(delta)>100000)return res.status(400).json({error:'Некорректное изменение ELO'});
  if(!db.prepare(`SELECT username FROM users WHERE username=?`).get(username))return res.status(404).json({error:'Аккаунт не найден'});
  db.prepare(`UPDATE users SET elo=MAX(0,elo+?) WHERE username=?`).run(delta,username);
  res.json(db.prepare(`SELECT username,elo,coins,banned FROM users WHERE username=?`).get(username));
});

// Выдача эксклюзивных предметов (например трека ФИНАЛА), недоступных за монеты
app.post('/api/admin/grant-item',auth,adminOnly,(req,res)=>{
  const username=req.body?.username,itemId=String(req.body?.itemId||'');
  const grant=req.body?.grant!==false; // по умолчанию true — выдать; false — отозвать
  const u=db.prepare(`SELECT * FROM users WHERE username=?`).get(username);
  if(!u)return res.status(404).json({error:'Аккаунт не найден'});
  let profile={};try{profile=JSON.parse(u.profile_json||'{}');}catch(e){}
  profile=Object.assign({},DEFAULT_PROFILE,profile);
  profile.items=Object.assign({},DEFAULT_PROFILE.items,profile.items||{});
  profile.items[itemId]=grant;
  if(!grant && profile.equipped && profile.equipped.finalTheme==='exclusive') profile.equipped.finalTheme='default';
  delete profile.elo; delete profile.coins;
  db.prepare(`UPDATE users SET profile_json=? WHERE username=?`).run(JSON.stringify(profile),username);
  res.json({ok:true,username,itemId,grant});
});

app.post('/api/admin/ban',auth,adminOnly,(req,res)=>{
  const username=req.body?.username,banned=!!req.body?.banned;
  if(username==='RAZRAB')return res.status(400).json({error:'RAZRAB нельзя заблокировать'});
  if(!db.prepare(`SELECT username FROM users WHERE username=?`).get(username))return res.status(404).json({error:'Аккаунт не найден'});
  db.prepare(`UPDATE users SET banned=? WHERE username=?`).run(banned?1:0,username);
  if(banned)db.prepare(`DELETE FROM sessions WHERE username=?`).run(username);
  res.json({ok:true,username,banned});
});

// Ручной бэкап/восстановление — страховка от сброса эфемерного диска Render при передеплое/переезде контейнера.
// RAZRAB должен иногда жать "Скачать бэкап" в админке; после сброса — "Восстановить из бэкапа".
app.get('/api/admin/backup',auth,adminOnly,(req,res)=>{
  const users=db.prepare(`SELECT * FROM users`).all();
  const promos=db.prepare(`SELECT username,code,redeemed_at FROM promo_redemptions`).all();
  res.json({version:1,exportedAt:new Date().toISOString(),users,promos});
});

app.post('/api/admin/restore',auth,adminOnly,(req,res)=>{
  const data=req.body||{};
  if(!Array.isArray(data.users))return res.status(400).json({error:'Некорректный файл бэкапа'});
  const tx=db.transaction(()=>{
    for(const u of data.users){
      if(!u||!u.username)continue;
      const exists=db.prepare(`SELECT username FROM users WHERE username=?`).get(u.username);
      if(exists){
        db.prepare(`UPDATE users SET password_hash=?,elo=?,coins=?,banned=?,admin=?,profile_json=? WHERE username=?`)
          .run(u.password_hash,u.elo|0,u.coins|0,u.banned?1:0,u.admin?1:0,u.profile_json||'{}',u.username);
      }else{
        db.prepare(`INSERT INTO users(username,password_hash,elo,coins,banned,admin,profile_json) VALUES(?,?,?,?,?,?,?)`)
          .run(u.username,u.password_hash,u.elo|0,u.coins|0,u.banned?1:0,u.admin?1:0,u.profile_json||'{}');
      }
    }
    if(Array.isArray(data.promos)){
      for(const p of data.promos){
        if(!p||!p.username||!p.code)continue;
        db.prepare(`INSERT OR IGNORE INTO promo_redemptions(username,code,redeemed_at) VALUES(?,?,?)`)
          .run(p.username,p.code,p.redeemed_at||new Date().toISOString());
      }
    }
  });
  try{ tx(); }catch(e){ return res.status(500).json({error:'Не удалось восстановить: '+e.message}); }
  res.json({ok:true,restoredUsers:data.users.length});
});

app.get('/api/leaderboard',auth,(req,res)=>{
  res.json(db.prepare(`SELECT username,elo,coins FROM users WHERE banned=0 ORDER BY elo DESC,coins DESC`).all());
});

app.listen(PORT,'0.0.0.0',()=>console.log(`AeroBall server listening on ${PORT}`));
