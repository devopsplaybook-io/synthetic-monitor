const fs = require("fs");
let devEnv = {};
if (fs.existsSync("./env-dev.js")) {
  console.log("Loading dev env");
  devEnv = require("./env-dev");
}

module.exports = {
  apps: [
    {
      name: "synthetic-monitor-server",
      cwd: "synthetic-monitor-server",
      script: "npm",
      args: "run dev",
      autorestart: false,
      env_development: {
        ...devEnv,
        DEV_MODE: "true",
      },
    },
  ],
};
