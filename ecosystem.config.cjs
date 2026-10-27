module.exports = {
  apps: [
    {
      name: "solarman",
      cwd: __dirname,
      script: "src/server.mjs",
      interpreter: "/opt/jilanov-node/node-v24.22.1-linux-x64/bin/node",
      interpreter_args: "--env-file=/home/mitko/.config/solarman/app.env",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      min_uptime: "15s",
      max_restarts: 10,
      restart_delay: 5000,
      kill_timeout: 360000,
      max_memory_restart: "400M",
      time: true,
      out_file: "/home/mitko/solarman/logs/output.log",
      error_file: "/home/mitko/solarman/logs/error.log",
      env: { NODE_ENV: "production", RELEASE_SHA: process.env.RELEASE_SHA },
    },
  ],
};
