'use strict';

// Timeweb Node.js App Platform starts server.js via PM2 by default, even
// when package.json defines npm start. A NEXT stand must never accidentally
// launch the legacy Apps Script/Cloudflare gateway or touch patient data.
// Only this feature branch contains the boot switch; production is unchanged.
if (process.env.MEDSI_NEXT_STAND === '1') {
  // Timeweb scans for an open port before it considers a container ready.
  // Load no external dependencies until the isolated diagnostic socket exists.
  console.log('MEDSI_NEXT_STAND_ENTRY_STARTED');
  const {startStandBootstrap} = require('./services/postgres-next/app/stand-bootstrap.cjs');
  const bootstrap = startStandBootstrap();
  import('./services/postgres-next/app/stand-server.mjs')
    .then(async ({startIsolatedStand}) => {
      // The PostgreSQL branch reuses the existing NEXT business logic.
      // Fail closed: PostgreSQL is opt-in; production gateway remains unchanged.
      const connection = await import('./services/postgres-next/src/connection.mjs');
      return startIsolatedStand(process.env, {
        connect: connection.connectPostgresNext,
        externalServer:bootstrap.server,
        installHandler:bootstrap.activate
      });
    })
    .catch(() => {
      // Missing dependencies are reported without leaking environment values
      // or database metadata. The diagnostic listener remains operational.
      bootstrap.fail();
    });
} else {
  console.error('MEDSI_NEXT_MODE_REQUIRED');
  process.exitCode = 1;
}
