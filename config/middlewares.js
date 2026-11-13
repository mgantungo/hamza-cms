module.exports = ({ env }) => [
  'strapi::logger',
  'strapi::errors',
  {
    name: 'strapi::cors',
    config: {
      // comma-separated list of front-end origins, e.g. https://assets.example.org
      origin: env.array('CORS_ORIGINS', ['http://localhost:3000']),
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
      headers: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Terminal-Token'],
      keepHeaderOnError: true,
    },
  },
  'strapi::security',
  'strapi::poweredBy',
  'strapi::query',
  {
    name: 'strapi::body',
    config: { formLimit: '20mb', jsonLimit: '20mb', textLimit: '20mb', formidable: { maxFileSize: 20 * 1024 * 1024 } },
  },
  'strapi::session',
  'strapi::favicon',
  'strapi::public',
  { name: 'strapi::compression', config: { br: false } },
];
