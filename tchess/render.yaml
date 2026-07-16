services:
  - type: web
    name: tchess
    runtime: node
    plan: free
    region: frankfurt
    buildCommand: npm install
    startCommand: npm start
    envVars:
      - key: BOT_TOKEN
        sync: false
      - key: PORT
        value: 3000
      # Необязательно: строка подключения к Postgres (например, Neon/Supabase).
      # Если оставить пустой, бот работает на JSON-файлах — рейтинг и история
      # обнулятся при передеплое/долгом простое. Заполните, чтобы данные
      # сохранялись постоянно. Подробности — в README.
      - key: DATABASE_URL
        sync: false
