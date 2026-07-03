// CSP-safe event delegation — replaces inline on* handlers so script-src-attr can drop
// 'unsafe-inline'. Handlers are declared with data-* attributes; the referenced functions are
// unchanged and must be reachable on window (top-level `function f(){}` in a classic script, or
// an explicit `window.f = f`). This changes only HOW functions are invoked, not what they do.
//
//   click:   <button data-action="fn">                         → fn()
//            <button data-action="fn" data-self>                → fn(el)
//            <button data-action="fn" data-arg="x">             → fn("x")
//            <button data-action="fn" data-arg-num="3">         → fn(3)
//            <button data-action="fn" data-arg="x" data-arg2="y">→ fn("x","y")
//   change:  <input data-action-change="fn" data-arg="x">       → fn("x")
//   input:   <input data-action-input="fn" ...>                 → fn(...)
//   submit:  <form  data-action-submit="fn">                    → e.preventDefault(); fn(event)
(function () {
  function callArgs(el) {
    const d = el.dataset;
    if ('self' in d) return [el];
    const a = [];
    if ('argNum' in d) a.push(Number(d.argNum));
    else if ('arg' in d) a.push(d.arg);
    else return a;
    if ('arg2Num' in d) a.push(Number(d.arg2Num));
    else if ('arg2' in d) a.push(d.arg2);
    return a;
  }
  function dispatch(el, attr) {
    const fn = window[el.dataset[attr]];
    if (typeof fn !== 'function') { console.warn('[actions] no such function:', el.dataset[attr]); return; }
    fn.apply(el, callArgs(el));
  }
  document.addEventListener('click', function (ev) {
    const el = ev.target.closest('[data-action]');
    if (el) dispatch(el, 'action');
  });
  document.addEventListener('change', function (ev) {
    const el = ev.target.closest('[data-action-change]');
    if (el) dispatch(el, 'actionChange');
  });
  document.addEventListener('input', function (ev) {
    const el = ev.target.closest('[data-action-input]');
    if (el) dispatch(el, 'actionInput');
  });
  document.addEventListener('submit', function (ev) {
    const el = ev.target.closest('[data-action-submit]');
    if (!el) return;
    ev.preventDefault();
    const fn = window[el.dataset.actionSubmit];
    if (typeof fn === 'function') fn.call(el, ev);
    else console.warn('[actions] no such submit function:', el.dataset.actionSubmit);
  });
})();
