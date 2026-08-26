const express = require("express");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 10000;

// ======================================================
// DATABASE
// ======================================================

const db = new Database(path.join(__dirname, "aeroball.db"));

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    elo INTEGER NOT NULL DEFAULT 1000,
    coins INTEGER NOT NULL DEFAULT 50,
    banned INTEGER NOT NULL DEFAULT 0,
    admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS promo_redemptions (
    username TEXT NOT NULL,
    code TEXT NOT NULL,
    redeemed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (username, code),

    FOREIGN KEY (username)
    REFERENCES users(username)
);

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (username)
    REFERENCES users(username)
);
`);

// ======================================================
// MIDDLEWARE
// ======================================================

app.use(express.json({ limit: "1mb" }));

// ======================================================
// PASSWORD HASH
// ======================================================

function hashPassword(password) {
    return crypto
        .createHash("sha256")
        .update(String(password))
        .digest("hex");
}

// ======================================================
// INITIAL ACCOUNTS
// ======================================================

const INITIAL_ACCOUNTS = [
    ["Artem", "Art", false],
    ["Vova", "Vovik", false],
    ["Miron", "Miroha", false],
    ["Sergey", "Seryy", false],
    ["Ilya", "Iluha", false],
    ["RAZRAB", "S1GMA", true]
];

const createUser = db.prepare(`
    INSERT OR IGNORE INTO users (
        username,
        password_hash,
        elo,
        coins,
        admin
    )
    VALUES (?, ?, 1000, 50, ?)
`);

for (const [username, password, admin] of INITIAL_ACCOUNTS) {
    createUser.run(
        username,
        hashPassword(password),
        admin ? 1 : 0
    );
}

// ======================================================
// PROMOCODES
// ======================================================

const PROMOS = {
    Get100r: 100,
    RAZRAB: 1000,
    WINNER: 500
};

// ======================================================
// GAME FILE
// ======================================================

// IMPORTANT:
// AeroBallFight-2.html must be in the SAME folder as server.js

const GAME_FILE = path.join(
    __dirname,
    "AeroBallFight-2.html"
);

// Main game page
app.get("/", (req, res) => {
    res.sendFile(GAME_FILE);
});

// Direct game URL
app.get("/AeroBallFight-2.html", (req, res) => {
    res.sendFile(GAME_FILE);
});

// ======================================================
// AUTHENTICATION
// ======================================================

function auth(req, res, next) {

    const authorization =
        req.get("authorization") || "";

    const token =
        authorization.startsWith("Bearer ")
            ? authorization.slice(7)
            : "";

    if (!token) {
        return res.status(401).json({
            error: "Требуется вход"
        });
    }

    const user = db.prepare(`
        SELECT
            u.username,
            u.elo,
            u.coins,
            u.banned,
            u.admin

        FROM sessions s

        JOIN users u
            ON u.username = s.username

        WHERE s.token = ?
    `).get(token);

    if (!user) {
        return res.status(401).json({
            error: "Сессия недействительна"
        });
    }

    if (user.banned) {
        return res.status(403).json({
            error: "Аккаунт заблокирован"
        });
    }

    req.user = user;
    req.token = token;

    next();
}

// ======================================================
// ADMIN AUTH
// ======================================================

function adminOnly(req, res, next) {

    if (!req.user.admin) {
        return res.status(403).json({
            error: "Недостаточно прав"
        });
    }

    next();
}

// ======================================================
// LOGIN
// ======================================================

app.post("/api/login", (req, res) => {

    const username =
        String(req.body?.username || "").trim();

    const password =
        String(req.body?.password || "");

    const user = db.prepare(`
        SELECT *
        FROM users
        WHERE username = ?
    `).get(username);

    if (!user) {
        return res.status(401).json({
            error: "Неверный ник или пароль"
        });
    }

    if (
        user.password_hash !==
        hashPassword(password)
    ) {
        return res.status(401).json({
            error: "Неверный ник или пароль"
        });
    }

    if (user.banned) {
        return res.status(403).json({
            error: "Аккаунт заблокирован"
        });
    }

    const token =
        crypto.randomBytes(32).toString("hex");

    db.prepare(`
        INSERT INTO sessions (
            token,
            username
        )
        VALUES (?, ?)
    `).run(
        token,
        user.username
    );

    res.json({
        token,

        user: {
            username: user.username,
            elo: user.elo,
            coins: user.coins,
            admin: Boolean(user.admin)
        }
    });
});

// ======================================================
// LOGOUT
// ======================================================

app.post("/api/logout", auth, (req, res) => {

    db.prepare(`
        DELETE FROM sessions
        WHERE token = ?
    `).run(req.token);

    res.json({
        ok: true
    });
});

// ======================================================
// CURRENT USER
// ======================================================

app.get("/api/me", auth, (req, res) => {

    const user = db.prepare(`
        SELECT
            username,
            elo,
            coins,
            banned,
            admin

        FROM users

        WHERE username = ?
    `).get(req.user.username);

    res.json({
        username: user.username,
        elo: user.elo,
        coins: user.coins,
        banned: Boolean(user.banned),
        admin: Boolean(user.admin)
    });
});

// ======================================================
// PROMOCODE
// ======================================================

app.post("/api/promo", auth, (req, res) => {

    const code =
        String(req.body?.code || "").trim();

    const reward = PROMOS[code];

    if (!reward) {
        return res.status(400).json({
            error: "Промокод не найден"
        });
    }

    try {

        const transaction = db.transaction(() => {

            db.prepare(`
                INSERT INTO promo_redemptions (
                    username,
                    code
                )
                VALUES (?, ?)
            `).run(
                req.user.username,
                code
            );

            db.prepare(`
                UPDATE users

                SET coins = coins + ?

                WHERE username = ?
            `).run(
                reward,
                req.user.username
            );
        });

        transaction();

    } catch (error) {

        return res.status(409).json({
            error:
                "Этот промокод уже активирован на аккаунте"
        });
    }

    const user = db.prepare(`
        SELECT
            username,
            elo,
            coins

        FROM users

        WHERE username = ?
    `).get(req.user.username);

    res.json({
        ok: true,
        reward,
        username: user.username,
        elo: user.elo,
        coins: user.coins
    });
});

// ======================================================
// ELO
// ======================================================

app.post("/api/elo", auth, (req, res) => {

    const delta =
        Number(req.body?.delta);

    if (
        !Number.isInteger(delta) ||
        Math.abs(delta) > 500
    ) {
        return res.status(400).json({
            error: "Некорректное изменение ELO"
        });
    }

    db.prepare(`
        UPDATE users

        SET elo = MAX(
            0,
            elo + ?
        )

        WHERE username = ?
    `).run(
        delta,
        req.user.username
    );

    const user = db.prepare(`
        SELECT
            username,
            elo,
            coins

        FROM users

        WHERE username = ?
    `).get(req.user.username);

    res.json(user);
});

// ======================================================
// LEADERBOARD
// ======================================================

app.get(
    "/api/leaderboard",
    auth,
    (req, res) => {

        const users = db.prepare(`
            SELECT
                username,
                elo,
                coins

            FROM users

            WHERE banned = 0

            ORDER BY
                elo DESC,
                coins DESC
        `).all();

        res.json(users);
    }
);

// ======================================================
// ADMIN — ALL ACCOUNTS
// ======================================================

app.get(
    "/api/users",
    auth,
    adminOnly,
    (req, res) => {

        const users = db.prepare(`
            SELECT
                username,
                elo,
                coins,
                banned,
                admin,
                created_at

            FROM users

            ORDER BY
                elo DESC,
                username ASC
        `).all();

        res.json(
            users.map(user => ({
                username: user.username,
                elo: user.elo,
                coins: user.coins,
                banned: Boolean(user.banned),
                admin: Boolean(user.admin),
                created_at: user.created_at
            }))
        );
    }
);

// ======================================================
// ADMIN — ADD / REMOVE COINS
// ======================================================

app.post(
    "/api/admin/coins",
    auth,
    adminOnly,
    (req, res) => {

        const username =
            String(req.body?.username || "").trim();

        const delta =
            Number(req.body?.delta);

        if (
            !Number.isInteger(delta) ||
            Math.abs(delta) > 1000000
        ) {
            return res.status(400).json({
                error:
                    "Некорректное изменение монет"
            });
        }

        const target = db.prepare(`
            SELECT username
            FROM users
            WHERE username = ?
        `).get(username);

        if (!target) {
            return res.status(404).json({
                error: "Аккаунт не найден"
            });
        }

        db.prepare(`
            UPDATE users

            SET coins = MAX(
                0,
                coins + ?
            )

            WHERE username = ?
        `).run(
            delta,
            username
        );

        const updated = db.prepare(`
            SELECT
                username,
                elo,
                coins,
                banned,
                admin

            FROM users

            WHERE username = ?
        `).get(username);

        res.json({
            ...updated,
            banned: Boolean(updated.banned),
            admin: Boolean(updated.admin)
        });
    }
);

// ======================================================
// ADMIN — CHANGE ELO
// ======================================================

app.post(
    "/api/admin/elo",
    auth,
    adminOnly,
    (req, res) => {

        const username =
            String(req.body?.username || "").trim();

        const delta =
            Number(req.body?.delta);

        if (
            !Number.isInteger(delta) ||
            Math.abs(delta) > 1000000
        ) {
            return res.status(400).json({
                error:
                    "Некорректное изменение ELO"
            });
        }

        const target = db.prepare(`
            SELECT username
            FROM users
            WHERE username = ?
        `).get(username);

        if (!target) {
            return res.status(404).json({
                error: "Аккаунт не найден"
            });
        }

        db.prepare(`
            UPDATE users

            SET elo = MAX(
                0,
                elo + ?
            )

            WHERE username = ?
        `).run(
            delta,
            username
        );

        const updated = db.prepare(`
            SELECT
                username,
                elo,
                coins,
                banned,
                admin

            FROM users

            WHERE username = ?
        `).get(username);

        res.json({
            ...updated,
            banned: Boolean(updated.banned),
            admin: Boolean(updated.admin)
        });
    }
);

// ======================================================
// ADMIN — BAN / UNBAN
// ======================================================

app.post(
    "/api/admin/ban",
    auth,
    adminOnly,
    (req, res) => {

        const username =
            String(req.body?.username || "").trim();

        const banned =
            Boolean(req.body?.banned);

        // Нельзя заблокировать самого RAZRAB
        if (username === "RAZRAB") {
            return res.status(400).json({
                error:
                    "RAZRAB нельзя заблокировать"
            });
        }

        const target = db.prepare(`
            SELECT username
            FROM users
            WHERE username = ?
        `).get(username);

        if (!target) {
            return res.status(404).json({
                error: "Аккаунт не найден"
            });
        }

        db.prepare(`
            UPDATE users

            SET banned = ?

            WHERE username = ?
        `).run(
            banned ? 1 : 0,
            username
        );

        // При бане уничтожаем активные сессии
        if (banned) {
            db.prepare(`
                DELETE FROM sessions
                WHERE username = ?
            `).run(username);
        }

        res.json({
            ok: true,
            username,
            banned
        });
    }
);

// ======================================================
// HEALTH CHECK
// ======================================================

app.get("/api/health", (req, res) => {

    res.json({
        ok: true,
        service: "AeroBall",
        time: new Date().toISOString()
    });
});

// ======================================================
// 404 FOR API
// ======================================================

app.use("/api", (req, res) => {

    res.status(404).json({
        error: "API endpoint not found"
    });
});

// ======================================================
// SERVER
// ======================================================

app.listen(PORT, "0.0.0.0", () => {

    console.log(
        `AeroBall server is running on port ${PORT}`
    );

});
