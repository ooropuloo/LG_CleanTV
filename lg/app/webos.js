// Tiny webOS shim for the boot page (packaged app, file://). Own code; ideas from couch-tv lg/app/webos.js (MIT).
(function () {
  var held = []; // keep PalmServiceBridge objects alive until their callback (else GC drops the call)
  function luna(uri, params, cb) {
    if (typeof window.PalmServiceBridge !== 'function') { if (cb) cb({ returnValue: false, errorText: 'no PalmServiceBridge' }); return false; }
    var b = new window.PalmServiceBridge(); held.push(b);
    b.onservicecallback = function (msg) {
      var r = {}; try { r = JSON.parse(msg); } catch (e) { /* */ }
      var i = held.indexOf(b); if (i >= 0) held.splice(i, 1);
      if (cb) cb(r);
    };
    b.call(uri, JSON.stringify(params || {}));
    return true;
  }
  function launch(id, params, cb) { return luna('luna://com.webos.applicationManager/launch', { id: id, params: params || {} }, cb); }
  // TODO(real TV): Developer Mode extend from inside the app (see bridge/devmode.py). Untested, not called.
  function extendDevMode(cb) { return launch('com.palmdts.devmode', { extend: true }, cb); }
  function activate() { try { if (window.PalmSystem && window.PalmSystem.activate) window.PalmSystem.activate(); } catch (e) { /* */ } }
  function exit() {
    try { if (window.PalmSystem && window.PalmSystem.platformBack) { window.PalmSystem.platformBack(); return; } } catch (e) { /* */ }
    try { window.close(); } catch (e) { /* */ }
  }
  window.tvWebOS = { luna: luna, launch: launch, extendDevMode: extendDevMode, activate: activate, exit: exit,
    isTV: /Web0S|webOS/i.test(navigator.userAgent) };
})();
