module.exports = {
  apps: [{
    name: 'assettracker-cms',
    script: 'node_modules/@strapi/strapi/bin/strapi.js',
    args: 'start',
    cwd: 'C:\\assettracker\\assettracker-cms',
    env: {
      NODE_ENV: 'production',
    }
  }]
};
