/**
 * Studio additions spliced into every artifact document before it reaches the
 * sandbox: the house serif as the default face, the reader's light/dark choice,
 * click points for comment popovers, and live agent cursors.
 */

const fontFaces = [
  ["Anthropic Serif Display", "Display-Light", 300],
  ["Anthropic Serif Display", "Display-Regular", 400],
  ["Anthropic Serif Display", "Display-Medium", 500],
  ["Anthropic Serif Text", "Text-Regular", 400],
] as const;

/**
 * Absolute font URLs on the studio origin. The sandbox may load fonts from any
 * origin (font-src *), so nothing is fetched here and the frame never needs
 * network access to the studio itself. /fonts answers with CORS for this.
 */
export function loadStudioFontCss(): Promise<string> {
  const origin = window.location.origin;
  return Promise.resolve(fontFaces.map(([family, file, weight]) =>
    `@font-face{font-family:"${family}";font-weight:${weight};font-style:normal;font-display:swap;src:url("${origin}/fonts/anthropic-serif/AnthropicSerif-${file}.otf") format("opentype");}`
  ).join(""));
}

/** Make `prefers-color-scheme` answer with the reader's choice, in CSS and JS. */
function forceColorScheme(html: string, isLight: boolean): string {
  const always = "(min-width: 0px)";
  const never = "(max-width: -1px)";
  return html
    .replace(/\(\s*prefers-color-scheme\s*:\s*dark\s*\)/giu, isLight ? never : always)
    .replace(/\(\s*prefers-color-scheme\s*:\s*light\s*\)/giu, isLight ? always : never);
}

const cursorAndClickScript = `
(function(){
  var DARK = __DARK__;
  var nativeMatch = window.matchMedia.bind(window);
  window.matchMedia = function(q){
    if (!/prefers-color-scheme/.test(q)) return nativeMatch(q);
    var hit = /dark/.test(q) === DARK;
    return {matches: hit, media: q, onchange: null, addListener: function(){}, removeListener: function(){},
      addEventListener: function(){}, removeEventListener: function(){}, dispatchEvent: function(){ return false; }};
  };
  // Click points let the host open a comment popover where the reader clicked.
  window.addEventListener('click', function(e){
    parent.postMessage({type: 'studio-click', x: e.clientX, y: e.clientY}, '*');
  }, true);
  // C toggles comment mode even while focus is inside the artifact.
  document.addEventListener('keydown', function(e){
    if (e.metaKey || e.ctrlKey || e.altKey || (e.key !== 'c' && e.key !== 'C')) return;
    var t = e.target;
    if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName || ''))) return;
    var sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // typing over a selection starts a comment
    e.preventDefault();
    parent.postMessage({type: 'studio-comment-mode'}, '*');
  }, true);

  // Agent cursors: one named arrow per working agent, parked on its thread's marker.
  var host = null, root = null, cursors = {}, raf = 0;
  function ensureHost(){
    if (host) return;
    host = document.createElement('div');
    host.setAttribute('data-studio-cursors', '');
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    root = host.attachShadow ? host.attachShadow({mode: 'open'}) : host;
    var style = document.createElement('style');
    style.textContent = [
      '.c{position:fixed;left:0;top:0;transition:transform .6s cubic-bezier(.2,.8,.2,1);will-change:transform;pointer-events:auto;cursor:pointer}',
      '.c svg{display:block;width:18px;height:18px;filter:drop-shadow(0 1px 2px rgba(20,20,19,.35))}',
      '.c span{position:absolute;left:14px;top:14px;white-space:nowrap;background:var(--k);color:#fff;font:500 11px/1 system-ui,-apple-system,sans-serif;font-variant-numeric:tabular-nums;padding:4px 8px;border-radius:999px 999px 999px 3px;box-shadow:0 1px 3px rgba(20,20,19,.25)}',
      '.c:hover span{filter:brightness(1.08)}',
      '@media (prefers-reduced-motion: reduce){.c{transition:none}}'
    ].join('');
    root.appendChild(style);
    document.documentElement.appendChild(host);
  }
  function markerRect(id){
    var overlay = document.querySelector('[data-plannotator-overlay-host]');
    var scope = overlay && (overlay.shadowRoot || overlay);
    var marker = scope && scope.querySelector('[data-annotation-id="' + String(id).replace(/"/g, '') + '"]');
    if (!marker || marker.style.display === 'none') return null;
    return marker.getBoundingClientRect();
  }
  function clock(ms){
    var s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function place(){
    raf = 0;
    var ids = Object.keys(cursors);
    for (var i = 0; i < ids.length; i++){
      var c = cursors[ids[i]], r = markerRect(ids[i]);
      var x = r ? r.right + 2 : window.innerWidth - 140 - i * 16;
      var y = r ? r.bottom - 4 : 72 + i * 30;
      c.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
      // Live elapsed time: proof the agent is alive, not hung.
      c.label.textContent = c.name + ' \u00b7 ' + clock(Date.now() - c.started);
    }
    if (ids.length) raf = requestAnimationFrame(place);
  }
  window.addEventListener('message', function(e){
    if (e.source !== parent || !e.data || e.data.type !== 'studio-locate') return;
    // Report where a thread lives so its reply card opens right there.
    var r = markerRect(e.data.id);
    if (!r) return;
    parent.postMessage({type: 'studio-click', x: r.right, y: r.top}, '*');
  });
  window.addEventListener('message', function(e){
    if (e.source !== parent || !e.data || e.data.type !== 'studio-cursors') return;
    ensureHost();
    var wanted = {};
    (e.data.cursors || []).forEach(function(item){
      wanted[item.id] = true;
      if (cursors[item.id]) return;
      var c = document.createElement('div');
      c.className = 'c';
      c.style.setProperty('--k', item.color || '#d97757');
      c.style.transform = 'translate(' + (window.innerWidth - 120) + 'px, 40px)';
      c.innerHTML = '<svg viewBox="0 0 18 18"><path d="M2 1.5 15.5 8 9.2 9.6 6.6 16z" fill="' + (item.color || '#d97757') + '" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg><span></span>';
      c.name = item.name;
      c.started = Date.now();
      c.label = c.querySelector('span');
      c.label.textContent = item.name;
      c.addEventListener('click', function(ev){
        ev.stopPropagation();
        parent.postMessage({type: 'studio-open', id: item.id}, '*');
      });
      root.appendChild(c);
      cursors[item.id] = c;
    });
    Object.keys(cursors).forEach(function(id){
      if (wanted[id]) return;
      cursors[id].remove();
      delete cursors[id];
    });
    if (!raf) raf = requestAnimationFrame(place);
  });
  // Comment bubbles show their agent status: working pulses, replied gets a dot.
  var statuses = {};
  var statusCss = [
    '.pn-marker[data-studio-status="working"] .pn-marker-icon{animation:studio-pulse 1.1s ease-in-out infinite}',
    '.pn-marker[data-studio-status="working"]::after{content:"";position:absolute;inset:-5px;border-radius:50%;border:2px solid #d97757;border-top-color:transparent;animation:studio-spin .9s linear infinite}',
    '.pn-marker[data-studio-status="replied"]::after{content:"";position:absolute;right:-3px;top:-3px;width:9px;height:9px;border-radius:50%;background:#5a8a5e;border:2px solid #fff}',
    '@keyframes studio-pulse{50%{transform:scale(1.12)}}',
    '@keyframes studio-spin{to{transform:rotate(1turn)}}',
    '@media (prefers-reduced-motion: reduce){.pn-marker .pn-marker-icon,.pn-marker::after{animation:none!important}}'
  ].join('');
  function paintStatuses(){
    var overlay = document.querySelector('[data-plannotator-overlay-host]');
    var scope = overlay && (overlay.shadowRoot || overlay);
    if (!scope) return;
    if (!scope.querySelector('style[data-studio-status]')){
      var st = document.createElement('style');
      st.setAttribute('data-studio-status', '');
      st.textContent = statusCss;
      scope.appendChild(st);
    }
    scope.querySelectorAll('.pn-marker').forEach(function(m){
      var s = statuses[m.getAttribute('data-annotation-id')];
      if (s) m.setAttribute('data-studio-status', s); else m.removeAttribute('data-studio-status');
    });
  }
  window.addEventListener('message', function(e){
    if (e.source !== parent || !e.data || e.data.type !== 'studio-statuses') return;
    statuses = e.data.statuses || {};
    paintStatuses();
  });
  // Markers are re-created as the page scrolls/reflows; keep the badges on.
  setInterval(paintStatuses, 500);
  parent.postMessage({type: 'studio-ready'}, '*');
})();
`;

/** Return the artifact document with the studio head block in front. */
export function withStudioInjection(html: string, isLight: boolean, fontCssText: string): string {
  const head = [
    `<style data-studio>${fontCssText}`,
    ':where(html){font-family:"Anthropic Serif Text",Georgia,serif;}',
    `:root{color-scheme:${isLight ? "light" : "dark"};}</style>`,
    `<script data-studio>${cursorAndClickScript.replace("__DARK__", isLight ? "false" : "true")}</script>`,
  ].join("");
  const themed = forceColorScheme(html, isLight);
  const headOpen = /<head\b[^>]*>/iu.exec(themed);
  if (headOpen !== null) {
    const at = headOpen.index + headOpen[0].length;
    return themed.slice(0, at) + head + themed.slice(at);
  }
  return head + themed;
}
