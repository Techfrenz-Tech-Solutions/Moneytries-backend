module.exports = {
  apps: [{
    name: 'moneytries-backend',
    script: 'server.js',
    cwd: '/var/www/Moneytries-backend',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    restart_delay: 3000,
    max_memory_restart: '500M',
    kill_timeout: 10000,
    listen_timeout: 15000,
    time: true,
    out_file: '/var/log/moneytries/out.log',
    error_file: '/var/log/moneytries/error.log',
    merge_logs: true,
    env: {
      NODE_ENV: 'production'
    }
  }]
};
