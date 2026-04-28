module.exports = {
  apps: [
    {
      name: "shared-reading-api",
      script: "server.js",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
        PORT: "3210",
        HOST: "127.0.0.1",
        STORE_PATH: "/var/lib/shared-reading/store.json",
        CORS_ORIGIN: "*"
      },
      max_memory_restart: "300M",
      time: true
    },
    {
      name: "shared-reading-web",
      script: "frontend.server.js",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
        FRONTEND_PORT: "3211",
        FRONTEND_HOST: "127.0.0.1",
        BACKEND_ORIGIN: "http://127.0.0.1:3210",
        FRONTEND_API_BASE_URL: ""
      },
      max_memory_restart: "300M",
      time: true
    }
  ]
};
