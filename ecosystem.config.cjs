module.exports = {
  apps: [
    {
      name: 'cmux-relay',
      script: '/opt/homebrew/bin/node',
      args: '/Users/jong-in/Documents/Github/cmux-relay/node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs src/index.ts',
      cwd: '/Users/jong-in/Documents/Github/cmux-relay/packages/relay',
      env: {
        NODE_ENV: 'production',
      },
      max_restarts: 10,
      restart_delay: 5000,
      kill_timeout: 10000,
      listen_timeout: 15000,
    },
  ],
};
