(function(){
  'use strict';
  // The new Node.js gateway implements /__session/api on the same origin.
  // Legacy Apps Script interception is intentionally disabled; do not rewrite
  // or forward browser fetch requests to external Google endpoints.
  window.__medsiTimewebSessionClient=true;
})();
