# AeroBall — общий сервер

## Запуск

Нужен Node.js 18+.

```bash
npm install
npm start
```

Открой:

http://localhost:3000

База `aeroball.db` создастся автоматически.

## Аккаунты

- Artem / Art
- Vova / Vovik
- Miron / Miroha
- Sergey / Seryy
- Ilya / Iluha
- RAZRAB / S1GMA

## API

- `POST /api/login`
- `POST /api/logout`
- `GET /api/me`
- `GET /api/leaderboard`
- `POST /api/promo`
- `POST /api/elo`
- `GET /api/users` (admin)
- `POST /api/admin/coins` (admin)
- `POST /api/admin/ban` (admin)

Промокоды:
- Get100r = 100
- RAZRAB = 1000
- WINNER = 500

Сейчас серверная часть готова. Следующий шаг — подключить существующий UI игры к этим API, чтобы он больше не использовал локальные монеты/ELO/аккаунты как источник истины.
