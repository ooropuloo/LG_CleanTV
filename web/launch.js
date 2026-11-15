// launch(appId, params): open another TV app.
// 1. webOS.service.request (if the webOSTV.js-style API exists in this page)
// 2. PalmServiceBridge directly (luna://com.webos.applicationManager/launch)
// 3. otherwise POST /api/launch to the bridge (501 stub for now -> caller shows a toast)
// Whether 1/2 exist in a *hosted* page on webOS 26 (and with/without requiredACG) must be tested on the TV.
const held = []; // keep bridges alive until their callback fires (else they can be garbage collected)

function viaWebOS(id, params) {
  return new Promise((resolve, reject) => {
    const svc = window.webOS && window.webOS.service;
    if (!svc || typeof svc.request !== 'function') return reject(new Error('no webOS.service'));
    svc.request('luna://com.webos.applicationManager', {
      method: 'launch', parameters: { id, params: params || {} },
      onSuccess: () => resolve('webOS'), onFailure: (e) => reject(new Error((e && e.errorText) || 'launch failed')),
    });
  });
}

function viaPalm(id, params) {
  return new Promise((resolve, reject) => {
    if (typeof window.PalmServiceBridge !== 'function') return reject(new Error('no PalmServiceBridge'));
    const b = new window.PalmServiceBridge(); held.push(b);
    const done = (fn, v) => { const i = held.indexOf(b); if (i >= 0) held.splice(i, 1); clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => done(reject, new Error('luna timeout')), 4000);
    b.onservicecallback = (msg) => {
      let r = {}; try { r = JSON.parse(msg); } catch (e) { /* ignore */ }
      if (r.returnValue === false) done(reject, new Error(r.errorText || 'launch refused'));
      else done(resolve, 'luna');
    };
    b.call('luna://com.webos.applicationManager/launch', JSON.stringify({ id, params: params || {} }));
  });
}

async function viaBridge(id, params) {
  const r = await fetch('api/launch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, params: params || {} }) });
  if (r.ok) return 'bridge';
  const e = new Error(r.status === 501 ? 'bridge-not-implemented' : 'bridge ' + r.status); e.status = r.status; throw e;
}

export async function launch(id, params) {
  const errors = [];
  for (const fn of [viaWebOS, viaPalm]) {
    try { return await fn(id, params); } catch (e) { errors.push(e.message); }
  }
  try { return await viaBridge(id, params); } catch (e) { e.tried = errors; throw e; }
}

export const isTV = /Web0S|webOS|NetCast/i.test(navigator.userAgent);
