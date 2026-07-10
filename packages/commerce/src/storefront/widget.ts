/**
 * Embeddable storefront widget.
 *
 *   GET /widget/loader.js   → tiny vanilla injector a brand drops on its site
 *   GET /widget/frame       → the chat UI (iframe document), SSR'd per brand
 *
 * A brand embeds:
 *   <script src="https://shop.felix.run/widget/loader.js"
 *           data-storefront="<brand_tenant>" async></script>
 *
 * The loader injects a launcher button + an iframe pointing at
 * `/widget/frame?storefront=<id>`. The frame is a self-contained document
 * (no build step) served from our origin, so its chat calls to
 * `/shop/:storefront/chat/stream` are same-origin. It **streams** tokens live
 * (SSE) and renders structured product cards (from `catalog_*` tool output)
 * and a Pay button (from `commerce_checkout` output) alongside the prose.
 *
 * Embedding is locked down: the frame's `frame-ancestors` is restricted to the
 * brand's registered `brand_domains` (falling back to `*` only when none are
 * registered yet). Disabled storefronts render a friendly unavailable page.
 *
 * Mounted at `/widget` in `app.ts`. Public — no auth.
 */

import type { Env } from '@felix/orchestrator/env';
import { Hono } from 'hono';
import { getBrandByDomain, getBrandByTenant, listDomains } from '../brands/store';

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

/** Only allow a safe hex colour from brand theme; else a neutral default. */
function accent(theme: Record<string, string>): string {
  const c = theme.accent || theme.primary || '';
  return /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '#111827';
}

const LOADER_JS = `(function(){
  var s = document.currentScript;
  if(!s){ return; }
  var storefront = s.getAttribute('data-storefront');
  if(!storefront){ console.error('[orderloop] data-storefront is required'); return; }
  var origin = new URL(s.src).origin;
  var color = s.getAttribute('data-color') || '#111827';
  var side = s.getAttribute('data-position') === 'left' ? 'left' : 'right';
  var Z = 2147483000;
  var frame = document.createElement('iframe');
  frame.src = origin + '/widget/frame?storefront=' + encodeURIComponent(storefront);
  frame.title = 'Shopping assistant';
  frame.setAttribute('allow','clipboard-write');
  frame.style.cssText = 'position:fixed;bottom:88px;'+side+':20px;width:384px;height:600px;'
    + 'max-width:calc(100vw - 40px);max-height:calc(100vh - 120px);border:0;border-radius:16px;'
    + 'z-index:'+Z+';box-shadow:0 12px 48px rgba(0,0,0,.28);display:none;background:#fff';
  var btn = document.createElement('button');
  btn.type='button'; btn.setAttribute('aria-label','Open chat');
  btn.style.cssText='position:fixed;bottom:20px;'+side+':20px;width:56px;height:56px;border-radius:50%;'
    + 'border:0;cursor:pointer;z-index:'+Z+';background:'+color+';color:#fff;font-size:24px;line-height:1;'
    + 'box-shadow:0 6px 20px rgba(0,0,0,.25)';
  btn.textContent='\\uD83D\\uDCAC';
  var open=false;
  function toggle(){ open=!open; frame.style.display=open?'block':'none'; btn.setAttribute('aria-label', open?'Close chat':'Open chat'); }
  btn.addEventListener('click',toggle);
  window.addEventListener('message',function(e){ if(e.source===frame.contentWindow && e.data==='orderloop:close'){ open=false; frame.style.display='none'; } });
  function mount(){ document.body.appendChild(frame); document.body.appendChild(btn); }
  if(document.body){ mount(); } else { document.addEventListener('DOMContentLoaded', mount); }
})();`;

const FRAME_STYLE = `
  :root{--accent:%COLOR%}
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111827;background:#fff}
  .wrap{display:flex;flex-direction:column;height:100%}
  header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:var(--accent);color:#fff;font-weight:600}
  header button{background:transparent;border:0;color:#fff;font-size:18px;cursor:pointer;line-height:1}
  #msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
  .m{max-width:85%;padding:8px 12px;border-radius:14px;white-space:pre-wrap;word-wrap:break-word}
  .u{align-self:flex-end;background:var(--accent);color:#fff;border-bottom-right-radius:4px}
  .a{align-self:flex-start;background:#f3f4f6;border-bottom-left-radius:4px}
  .a a{color:var(--accent);font-weight:600}
  .cards{align-self:stretch;display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .card{border:1px solid #e5e7eb;border-radius:12px;padding:10px;display:flex;flex-direction:column;gap:6px}
  .ct{font-weight:600;font-size:13px}
  .cp{color:#6b7280;font-size:12px}
  .addbtn{margin-top:auto;border:0;border-radius:8px;background:var(--accent);color:#fff;padding:6px 8px;cursor:pointer;font-size:12px;font-weight:600}
  .addbtn:disabled{opacity:.5;cursor:default}
  .paybtn{align-self:flex-start;text-decoration:none;background:#16a34a;color:#fff;padding:10px 16px;border-radius:10px;font-weight:700}
  form{display:flex;gap:8px;padding:12px;border-top:1px solid #e5e7eb}
  input{flex:1;padding:10px 12px;border:1px solid #d1d5db;border-radius:10px;font:inherit;outline:none}
  input:focus{border-color:var(--accent)}
  button.send{padding:0 16px;border:0;border-radius:10px;background:var(--accent);color:#fff;cursor:pointer;font-weight:600}
  button.send:disabled{opacity:.5;cursor:default}`;

function frameHtml(opts: {
  name: string;
  greeting: string;
  storefront: string;
  color: string;
}): string {
  const greeting = opts.greeting || `Hi! How can I help you shop with ${opts.name} today?`;
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.name)}</title>
<style>${FRAME_STYLE.replace('%COLOR%', opts.color)}</style></head>
<body><div class="wrap">
  <header><span>${esc(opts.name)}</span><button id="x" aria-label="Close">✕</button></header>
  <div id="msgs"></div>
  <form id="f"><input id="t" autocomplete="off" placeholder="Ask about products, your cart…"><button class="send" type="submit">Send</button></form>
</div>
<script>
(function(){
  var STOREFRONT=${JSON.stringify(opts.storefront)};
  var GREETING=${JSON.stringify(greeting)};
  var KEY='orderloop_thread_'+STOREFRONT;
  var thread=null;
  try{ thread=localStorage.getItem(KEY); }catch(e){}
  if(!thread){ thread='w-'+Math.random().toString(36).slice(2)+Date.now().toString(36); try{localStorage.setItem(KEY,thread);}catch(e){} }
  var msgs=document.getElementById('msgs'), form=document.getElementById('f'), input=document.getElementById('t'), send=form.querySelector('.send');
  document.getElementById('x').addEventListener('click',function(){ if(window.parent!==window){ window.parent.postMessage('orderloop:close','*'); } });
  function esc(s){ return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  function linkify(s){ return esc(s).replace(/(https?:\\/\\/[^\\s<]+)/g,function(u){ return '<a href="'+u+'" target="_blank" rel="noopener">'+u+'</a>'; }); }
  function money(c){ return '$'+(Number(c)/100).toFixed(2); }
  function row(role,html){ var d=document.createElement('div'); d.className='m '+(role==='user'?'u':'a'); d.innerHTML=html; msgs.appendChild(d); msgs.scrollTop=msgs.scrollHeight; return d; }
  row('assistant',linkify(GREETING));
  function busy(b){ send.disabled=b; input.disabled=b; }

  function renderCards(products){
    var seen={}, list=[];
    products.forEach(function(p){ if(p&&p.id&&!seen[p.id]){ seen[p.id]=1; list.push(p); } });
    if(!list.length) return;
    var wrap=document.createElement('div'); wrap.className='cards';
    list.forEach(function(p){
      var card=document.createElement('div'); card.className='card';
      var meta=(p.price_cents!=null?money(p.price_cents):'')+(p.category?' · '+esc(p.category):'');
      card.innerHTML='<div class="ct">'+esc(p.title||p.id)+'</div><div class="cp">'+meta+'</div>';
      var b=document.createElement('button'); b.className='addbtn';
      if(p.in_stock===false){ b.textContent='Out of stock'; b.disabled=true; }
      else { b.textContent='Add to cart'; b.addEventListener('click',function(){ submit('Add '+(p.title||p.id)+' to my cart'); }); }
      card.appendChild(b); wrap.appendChild(card);
    });
    msgs.appendChild(wrap); msgs.scrollTop=msgs.scrollHeight;
  }
  function renderPay(url){ var a=document.createElement('a'); a.className='paybtn'; a.href=url; a.target='_blank'; a.rel='noopener'; a.textContent='Complete payment'; msgs.appendChild(a); msgs.scrollTop=msgs.scrollHeight; }

  function handleTool(name, output, cards, setPay){
    var out = typeof output==='string'?output:JSON.stringify(output);
    if(name && name.indexOf('catalog_')===0){
      try{ var d=JSON.parse(out); if(Array.isArray(d)){ d.forEach(function(p){cards.push(p);}); } else if(d&&d.id){ cards.push(d); } }catch(e){}
    }
    if(name==='commerce_checkout'){ var m=out.match(/https?:\\/\\/[^\\s]+/); if(m) setPay(m[0]); }
  }

  function submit(text){
    if(!text) return;
    row('user',esc(text)); busy(true);
    var bubble=row('assistant','…'); var acc=''; var cards=[]; var pay=null;
    fetch('/shop/'+encodeURIComponent(STOREFRONT)+'/chat/stream',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({messages:[{role:'user',content:text}],thread_id:thread})
    }).then(function(resp){
      if(!resp.body){ return resp.json().then(function(j){ acc=(j&&j.error)?('Sorry ('+j.error+').'):'Sorry, no response.'; bubble.innerHTML=linkify(acc); }); }
      var reader=resp.body.getReader(), dec=new TextDecoder(), buf='';
      function pump(){ return reader.read().then(function(r){
        if(r.done){ if(!acc) bubble.innerHTML=linkify('(no response)'); renderCards(cards); if(pay) renderPay(pay); busy(false); input.focus(); return; }
        buf+=dec.decode(r.value,{stream:true});
        var parts=buf.split('\\n\\n'); buf=parts.pop();
        parts.forEach(function(chunk){
          var line=chunk.replace(/^data: ?/,'');
          if(!line||line==='[DONE]') return;
          var ev; try{ ev=JSON.parse(line); }catch(e){ return; }
          if(ev.event==='on_chat_model_stream'){ acc+=ev.data.chunk.content; bubble.innerHTML=linkify(acc); msgs.scrollTop=msgs.scrollHeight; }
          else if(ev.event==='on_tool_end'){ handleTool(ev.data.name, ev.data.output, cards, function(u){pay=u;}); }
          else if(ev.event==='on_error'){ acc+=(acc?'\\n':'')+'(error: '+ev.data.message+')'; bubble.innerHTML=linkify(acc); }
        });
        return pump();
      }); }
      return pump();
    }).catch(function(){ bubble.innerHTML=linkify(acc||'Sorry, the assistant is unavailable right now.'); busy(false); });
  }

  form.addEventListener('submit',function(e){ e.preventDefault(); var t=input.value.trim(); input.value=''; submit(t); });
})();
</script>
</body></html>`;
}

function unavailableHtml(name: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(name)}</title>
<style>html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center;font:14px system-ui,sans-serif;color:#6b7280;background:#fff;text-align:center;padding:24px}</style>
</head><body><div><strong>${esc(name)}</strong><br>The shop is temporarily unavailable. Please check back soon.</div></body></html>`;
}

export function buildWidgetRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/loader.js', () => {
    return new Response(LOADER_JS, {
      headers: {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'public, max-age=300',
      },
    });
  });

  app.get('/frame', async (c) => {
    const storefront = c.req.query('storefront');
    const brand = storefront
      ? await getBrandByTenant(c.env, storefront)
      : await getBrandByDomain(c.env, c.req.header('host') ?? '');
    if (!brand) return c.text('storefront not found', 404);
    if (brand.status !== 'active') {
      return new Response(unavailableHtml(brand.name), {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': 'frame-ancestors *',
        },
      });
    }
    // Lock embedding to the brand's registered domains; permissive only until
    // the operator registers at least one storefront host.
    const domains = await listDomains(c.env, brand.tenant_id, brand.id);
    const ancestors = domains.length
      ? `'self' ${domains.map((h) => `https://${h}`).join(' ')}`
      : '*';
    const html = frameHtml({
      name: brand.name,
      greeting: brand.identity.greeting,
      storefront: brand.brand_tenant,
      color: accent(brand.identity.theme),
    });
    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': `frame-ancestors ${ancestors}`,
      },
    });
  });

  return app;
}
