#!/usr/bin/env node
'use strict';

if (!process.env.PORT) {
  process.env.PORT = '3010';
}

console.warn('⚠️  `server.js` quedó solo como shim de compatibilidad. Usá `./dashboard` o `PORT=3010 node web.js`.');

require('./web');
