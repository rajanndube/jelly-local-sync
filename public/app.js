(() => {
  const TOKEN = window.JELLY.token;
  const PORT = window.JELLY.port;
  const BOUND_HOST = window.JELLY.host;   // the host the server bound to (HOST env)
  const LAN_IP = window.JELLY.lanIp;
  // Ranked candidate LAN addresses, best first (server-injected JS literal).
  // Each is { ip, iface }, the interface name lets the address picker label
  // each option so the user can tell Wi-Fi from a VPN/Docker adapter.
  const LAN_IPS = window.JELLY.lanIps;
  const ORIGIN = location.origin;
  const BASE = ORIGIN + '/r/' + TOKEN;

  const endpointUrl = BASE;
  const lanEndpointFor = (ip) => (ip ? `http://${ip}:${PORT}/r/${TOKEN}` : '');
  // Mutable: the address picker reassigns these so drawQR / the LAN-URL field /
  // the copy button all follow the currently selected address.
  let lanIpSel = LAN_IP || (LAN_IPS[0]?.ip ?? '');
  let lanEndpoint = lanEndpointFor(lanIpSel);

  const $ = (id) => document.getElementById(id);

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 1400);
  }

  function flashCopied(btn) {
    if (!btn) { toast('Copied'); return; }
    // Icon-only buttons (e.g. the image overlay) must keep their SVG, flash the
    // copied state via a class + a toast instead of overwriting the label.
    if (btn.dataset.icon) {
      btn.classList.add('copied');
      setTimeout(() => btn.classList.remove('copied'), 1100);
      toast('Copied');
      return;
    }
    const orig = btn.textContent;
    btn.textContent = 'Copied';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1100);
  }

  // Text copy. Modern Clipboard API first; hidden-textarea fallback when
  // navigator.clipboard is unavailable (http://<LAN-IP> isn't a secure context).
  async function copy(text, btn) {
    let ok = false;
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(text); ok = true; } catch { /* fall through */ }
    }
    if (!ok) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '0';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try { ta.setSelectionRange(0, text.length); } catch {}
      try { ok = document.execCommand('copy'); } catch {}
      document.body.removeChild(ta);
    }
    if (ok) flashCopied(btn);
    else toast('Copy failed, try ⌘/Ctrl+C');
  }

  // Re-encode any image Blob (often image/webp) to PNG, clipboard.write only
  // accepts image/png in Chrome and Safari.
  async function blobToPng(blob) {
    if (blob.type === 'image/png') return blob;
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('image decode failed'));
        i.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      canvas.getContext('2d').drawImage(img, 0, 0);
      return await new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob failed'))), 'image/png');
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function copyImage(imgUrl, btn) {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
      toast('Image clipboard not supported, opening for manual copy');
      try { window.open(imgUrl, '_blank'); } catch {}
      return;
    }
    try {
      const item = new ClipboardItem({
        'image/png': fetch(imgUrl).then((r) => r.blob()).then(blobToPng),
      });
      await navigator.clipboard.write([item]);
      flashCopied(btn);
    } catch {
      try {
        const blob = await blobToPng(await (await fetch(imgUrl)).blob());
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        flashCopied(btn);
      } catch {
        toast('Image clipboard blocked, opening for manual copy');
        try { window.open(imgUrl, '_blank'); } catch {}
      }
    }
  }

  // ── Connect panel ────────────────────────────────────────────────────────
  // "Connecting a device" is one action: point the phone at the QR. The QR is
  // the hero; pasting the URL is the quiet fallback; per-platform steps tuck
  // behind a disclosure. The same panel is the empty-state hero (main column,
  // before any device pairs) and the "Connect another device" modal afterwards.
  //
  // The QR encodes the LAN URL, the only URL a phone camera can resolve
  // (localhost would mean "the phone itself"). Vendored qrcode-generator (MIT).
  // Generic QR rasteriser, encodes `text` onto `canvas`. Used for the main
  // connect QR (lanEndpoint) and the troubleshooter's diagnostic QR.
  function renderQR(canvas, text, scale = 5) {
    if (!text || typeof qrcode === 'undefined') return false;
    try {
      const qr = qrcode(0, 'L');
      qr.addData(text);
      qr.make();
      const size = qr.getModuleCount();
      const padding = 4;
      const px = (size + padding * 2) * scale;
      canvas.width = px;
      canvas.height = px;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, px, px);
      ctx.fillStyle = '#000000';
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (qr.isDark(y, x)) ctx.fillRect((x + padding) * scale, (y + padding) * scale, scale, scale);
        }
      }
      return true;
    } catch { return false; }
  }
  function drawQR(canvas) { return renderQR(canvas, lanEndpoint, 5); }

  // Switch the advertised LAN address everywhere at once, every connect panel
  // currently in the DOM (hero + modal), its QR, LAN-URL field, and the active
  // address-picker chip. Called by the picker and by the troubleshooter when a
  // phone reports which address it can actually reach.
  function applyLanIp(ip) {
    lanIpSel = ip;
    lanEndpoint = lanEndpointFor(ip);
    document.querySelectorAll('.cp-qr canvas').forEach((c) => drawQR(c));
    document.querySelectorAll('.cp-lan').forEach((i) => { i.value = lanEndpoint; });
    document.querySelectorAll('.addr-chip').forEach((c) => {
      c.classList.toggle('active', c.querySelector('.ip')?.textContent === ip);
    });
  }

  const CP_HTML = `
    <div class="connect-shell">
      <div class="cp">
        <div class="cp-qr"><canvas aria-label="QR code to connect a device"></canvas><p class="qr-hint"></p></div>
        <h3 class="cp-title"></h3>
        <p class="cp-sub"></p>
        <div class="addr-picker" hidden>
          <p class="addr-picker-head">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 6.5a8 8 0 0 1 12 0"/><path d="M4.3 9a5 5 0 0 1 7.4 0"/><path d="M6.5 11.4a2 2 0 0 1 3 0"/><circle cx="8" cy="13.5" r="0.5" fill="currentColor"/></svg>
            Phone won't connect? Pick its network
          </p>
          <p class="addr-picker-sub">Multiple networks detected. The QR points at the highlighted one, if your phone can't open it, choose the address on the same Wi-Fi as the phone.</p>
          <div class="addr-list"></div>
        </div>
        <div class="cp-or">or paste the URL</div>
        <div class="cp-fields">
          <p class="field-label">Endpoint URL</p>
          <div class="url-box">
            <input class="url-input cp-endpoint" readonly />
            <button class="primary cp-copy" type="button">Copy</button>
          </div>
          <div class="lan-row cp-lanrow" hidden>
            <p class="field-label">LAN URL, for iOS / other Wi-Fi devices</p>
            <div class="url-box">
              <input class="url-input lan cp-lan" readonly />
              <button class="cp-copy-lan" type="button">Copy</button>
            </div>
          </div>
        </div>
        <div class="cp-toggles">
          <button class="cp-toggle cp-help-toggle" type="button" data-view="setup" aria-expanded="false">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><path d="M6.2 6.1a1.8 1.8 0 0 1 3.5.6c0 1.2-1.8 1.5-1.8 2.5"/><path d="M8 11.6v.01"/></svg>
            <span class="label">Setup help</span>
            <svg class="chev" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>
          </button>
          <button class="cp-toggle cp-trouble-toggle" type="button" data-view="trouble" aria-expanded="false">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.5l6 3v4c0 3.5-2.4 5.6-6 6.5-3.6-.9-6-3-6-6.5v-4z"/><path d="M8 5.5v3"/><path d="M8 10.8v.01"/></svg>
            <span class="label">Troubleshooting</span>
            <svg class="chev" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>
          </button>
        </div>
        <p class="refresh-note">Refresh this page to start a fresh, isolated session, the URL rotates and the old one stops accepting writes.</p>
      </div>
      <div class="cp-setup" aria-hidden="true">
        <div class="cp-setup-inner">
        <div class="cp-view" data-view="setup">
          <h4 class="cp-setup-title">Set up your device</h4>
          <div class="tabs" role="tablist">
            <button class="tab active" data-tab="android" type="button">Android</button>
            <button class="tab" data-tab="ios" type="button">iOS</button>
            <button class="tab" data-tab="web" type="button">Web</button>
          </div>
          <div class="tab-panel active" data-panel="android">
            <ol class="setup-steps">
              <li><span class="num">1</span><span>Plug in with USB and enable <b>USB debugging</b> (Settings &rarr; Developer options).</span></li>
              <li><span class="num">2</span><span>In a terminal on this machine, run:
                <div class="cmd"><code>adb reverse tcp:${PORT} tcp:${PORT}</code><button class="cmd-copy" type="button">Copy</button></div>
                The phone's <code>localhost:${PORT}</code> now tunnels over USB to this server.</span></li>
              <li><span class="num">3</span><span>Paste the <b>Endpoint URL</b> into the Jelly toolbar and toggle <b>Sync</b> on.</span></li>
            </ol>
            <div class="note"><b>Note:</b> several USB devices tunnelling to one port look like a single client here. For multi-device QA, pair phones over Wi-Fi, each gets its own row.</div>
          </div>
          <div class="tab-panel" data-panel="ios">
            <ol class="setup-steps">
              <li><span class="num">1</span><span>Put the iPhone and this laptop on the same Wi-Fi network.</span></li>
              <li><span class="num">2</span><span>Scan the QR with the iOS camera, or paste the <b>LAN URL</b> into the Jelly toolbar's <b>Endpoint</b> setting.</span></li>
              <li><span class="num">3</span><span>Toggle <b>Sync</b> on. Grant <b>Local Network</b> permission if iOS prompts.</span></li>
            </ol>
            <div class="note"><b>Why no cable mode?</b> iOS has no standard tool routing the device's <code>localhost</code> back to the Mac, so Wi-Fi + LAN URL is the path. MDMs that block local-network traffic block this.</div>
          </div>
          <div class="tab-panel" data-panel="web">
            <ol class="setup-steps">
              <li><span class="num">1</span><span>Open the page hosting the Jelly browser toolbar.</span></li>
              <li><span class="num">2</span><span>Paste the <b>Endpoint URL</b> into the toolbar and toggle <b>Sync</b> on.</span></li>
              <li><span class="num">3</span><span>Same machine, same origin, no tunnelling needed.</span></li>
            </ol>
          </div>
        </div>
        <div class="cp-view" data-view="trouble">
          <h4 class="cp-setup-title">Troubleshooting</h4>
          <details class="trouble-q">
            <summary>Phone scans the QR but nothing loads<svg class="tq-chev" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg></summary>
            <div class="trouble-body">
              <p>The phone and this laptop must be on the <b>same Wi-Fi network</b>. The QR encodes a LAN address, if that address isn't reachable from the phone, scanning opens a dead link.</p>
              <p>If more than one network was detected, use the <b>address picker</b> on this panel and choose the address that matches your phone's Wi-Fi IP (on the phone: <b>Settings → Wi-Fi → ⓘ</b>). VPN and Docker adapters get listed too, but a phone can't reach those.</p>
            </div>
          </details>
          <details class="trouble-q">
            <summary>Same Wi-Fi, still won't connect<svg class="tq-chev" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg></summary>
            <div class="trouble-body">
              <p>A <b>firewall</b> is probably blocking the port. On macOS: <b>System Settings → Network → Firewall → Options</b> and allow incoming connections for <code>node</code>. On Windows: approve <b>Node.js</b> on <b>Private networks</b> in the Defender Firewall prompt.</p>
              <p>Guest and corporate Wi-Fi often enable <b>client isolation</b>, which blocks phone-to-laptop traffic entirely. Use a personal hotspot, or pair an Android device over USB instead.</p>
            </div>
          </details>
          <details class="trouble-q">
            <summary>Android: "couldn't reach endpoint"<svg class="tq-chev" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg></summary>
            <div class="trouble-body">
              <p>Android blocks plaintext <code>http://</code> by default. The debug build needs <code>usesCleartextTraffic="true"</code> in its manifest.</p>
              <p>Or skip Wi-Fi entirely over USB: run <code>adb reverse tcp:${PORT} tcp:${PORT}</code>, then paste the <b>Endpoint URL</b> (the localhost one) rather than the LAN URL.</p>
            </div>
          </details>
          <details class="trouble-q">
            <summary>iOS won't connect<svg class="tq-chev" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg></summary>
            <div class="trouble-body">
              <p>iOS is <b>Wi-Fi only</b>, there's no cable-mode pairing. Grant <b>Local Network</b> permission when iOS prompts.</p>
              <p>MDM-managed devices that block local-network traffic can't pair, and there is no workaround on iOS.</p>
            </div>
          </details>
          <details class="trouble-q">
            <summary>Connected, but no annotations appear<svg class="tq-chev" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg></summary>
            <div class="trouble-body">
              <p>Confirm <b>Sync</b> is toggled on in the toolbar and that you pasted <b>this page's exact URL</b>. Refreshing the page rotates the URL, re-pair the device after any refresh.</p>
            </div>
          </details>
          <details class="trouble-q">
            <summary>Page stuck on "Reconnecting…"<svg class="tq-chev" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg></summary>
            <div class="trouble-body">
              <p>The server restarted. Refresh this page for a fresh session, then re-pair the device.</p>
            </div>
          </details>
          <details class="trouble-q">
            <summary>All devices show as one row<svg class="tq-chev" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg></summary>
            <div class="trouble-body">
              <p>Those devices share one IP, usually several <code>adb reverse</code> tunnels to the same port, or devices behind NAT. Pair over Wi-Fi so each device gets its own address and its own row.</p>
            </div>
          </details>
        </div>
        </div>
      </div>
    </div>`;

  function buildConnectPanel() {
    const root = document.createElement('div');
    root.innerHTML = CP_HTML;
    const shell = root.firstElementChild;

    const qrBox = shell.querySelector('.cp-qr');
    const hint = shell.querySelector('.qr-hint');
    const hasQR = drawQR(shell.querySelector('.cp-qr canvas'));
    if (hasQR) {
      shell.querySelector('.cp-title').textContent = 'Scan to connect';
      shell.querySelector('.cp-sub').textContent = "Point your phone's camera at the code, it opens the Jelly endpoint automatically.";
    } else {
      // No LAN IP: greyed QR placeholder keeps the layout, paste becomes primary.
      qrBox.classList.add('disabled');
      hint.textContent = 'Connect to Wi-Fi to enable scanning';
      shell.querySelector('.cp-title').textContent = 'Paste to connect';
      shell.querySelector('.cp-sub').textContent = 'No Wi-Fi network detected. Paste the endpoint URL into the Jelly toolbar, or join a Wi-Fi network to scan a QR.';
      shell.querySelector('.cp-or').hidden = true;
    }

    shell.querySelector('.cp-endpoint').value = endpointUrl;
    shell.querySelector('.cp-copy').addEventListener('click', (e) => copy(endpointUrl, e.currentTarget));
    if (lanEndpoint && lanEndpoint !== endpointUrl) {
      shell.querySelector('.cp-lanrow').hidden = false;
      shell.querySelector('.cp-lan').value = lanEndpoint;
      // Reads lanEndpoint at click time so it follows the IP switch below.
      shell.querySelector('.cp-copy-lan').addEventListener('click', (e) => copy(lanEndpoint, e.currentTarget));
    }

    // When more than one interface was detected, the auto-pick may not be the
    // network the phone is on (VPN / Docker / VM adapters). Show an explicit,
    // prominent picker, one selectable row per address, labelled with its
    // interface, so the user can switch to the one their phone can reach.
    // Selecting re-encodes the QR and updates the LAN URL field live.
    const picker = shell.querySelector('.addr-picker');
    if (hasQR && LAN_IPS.length > 1) {
      const list = picker.querySelector('.addr-list');
      LAN_IPS.forEach(({ ip, iface }, i) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'addr-chip' + (ip === lanIpSel ? ' active' : '');
        chip.innerHTML = `<span class="radio"></span><span class="ip"></span><span class="iface"></span>`;
        chip.querySelector('.ip').textContent = ip;
        chip.querySelector('.iface').textContent = i === 0 ? `${iface} · recommended` : iface;
        chip.addEventListener('click', () => applyLanIp(ip));
        list.appendChild(chip);
      });
      picker.hidden = false;
    }

    // Two slide-out toggles (Setup help · Troubleshooting) share one panel.
    // Clicking a toggle opens its view; clicking the active one again collapses.
    const setup = shell.querySelector('.cp-setup');
    const toggles = [...shell.querySelectorAll('.cp-toggle')];
    const baseLabel = { setup: 'Setup help', trouble: 'Troubleshooting' };
    let activeView = null;
    const syncToggles = () => {
      const open = activeView != null;
      shell.classList.toggle('expanded', open);
      setup.setAttribute('aria-hidden', String(!open));
      shell.querySelectorAll('.cp-view').forEach((v) => v.classList.toggle('active', v.dataset.view === activeView));
      toggles.forEach((t) => {
        const on = t.dataset.view === activeView;
        t.classList.toggle('active', on);
        t.setAttribute('aria-expanded', String(on));
        t.querySelector('.label').textContent = on ? `Hide ${baseLabel[t.dataset.view].toLowerCase()}` : baseLabel[t.dataset.view];
      });
    };
    toggles.forEach((t) => t.addEventListener('click', () => {
      activeView = activeView === t.dataset.view ? null : t.dataset.view;
      syncToggles();
    }));

    shell.querySelectorAll('.tab').forEach((btn) => btn.addEventListener('click', () => {
      const name = btn.dataset.tab;
      shell.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
      shell.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
    }));
    shell.querySelectorAll('.cmd-copy').forEach((btn) => btn.addEventListener('click', () => {
      const code = btn.closest('.cmd')?.querySelector('code')?.textContent?.trim();
      if (code) copy(code, btn);
    }));
    return shell;
  }

  // Main column shows the connect hero until a device pairs, then the feed.
  // (Devices are never removed within a session, so the hero only ever shows
  // at the start, build its QR once.)
  function syncMainView() {
    const hasDevices = devices.size > 0;
    $('connect-hero').hidden = hasDevices;
    $('feed-view').hidden = !hasDevices;
    $('connect-btn').hidden = !hasDevices;
    if (!hasDevices && !$('connect-hero').firstElementChild) {
      $('connect-hero').appendChild(buildConnectPanel());
    }
  }

  // "Connect another device" modal (reachable once ≥1 device is paired).
  function openConnectModal() {
    const mount = $('connect-modal-mount');
    mount.innerHTML = '';
    mount.appendChild(buildConnectPanel());
    $('connect-modal').hidden = false;
    setTimeout(() => $('connect-close').focus(), 0);
  }
  function closeConnectModal() {
    $('connect-modal').hidden = true;
    $('connect-modal-mount').innerHTML = '';
  }
  $('connect-btn').addEventListener('click', openConnectModal);
  $('connect-close').addEventListener('click', closeConnectModal);
  $('connect-modal').addEventListener('click', (e) => { if (e.target === $('connect-modal')) closeConnectModal(); });

  // ── Integrations (ClickUp live; Jira / Linear coming soon) ────────────────
  // The ClickUp connection is process-global on the server (one OAuth token per
  // machine), so the page only mirrors /clickup/status and drives the OAuth
  // popup. The popup's callback page postMessages back here when it lands.
  let clickup = { configured: false, connected: false, teamName: null };

  // Official ClickUp mark (Simple Icons, MIT) — the two-chevron glyph. Rendered
  // inline so the logo shows everywhere ClickUp appears without a network fetch.
  const CU_PATH = 'M2 18.439l3.69-2.828c1.961 2.56 4.044 3.739 6.363 3.739 2.307 0 4.33-1.166 6.203-3.704L22 18.405C19.298 22.065 15.941 24 12.053 24 8.178 24 4.788 22.078 2 18.439zM12.04 6.15l-6.568 5.66-3.036-3.52L12.055 0l9.543 8.296-3.05 3.509z';
  function cuLogo(size = 16, color = 'currentColor') {
    return `<svg class="cu-glyph" viewBox="0 0 24 24" width="${size}" height="${size}" fill="${color}" aria-hidden="true"><path d="${CU_PATH}"/></svg>`;
  }

  // Icon-only buttons that overlay the screenshot (copy / open in new tab).
  const ICON_COPY = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1.6"/><path d="M11 5.5V3.6A1.6 1.6 0 0 0 9.4 2H3.6A1.6 1.6 0 0 0 2 3.6v5.8A1.6 1.6 0 0 0 3.6 11h1.9"/></svg>';
  const ICON_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>';
  function imgActionBtn(label, svg, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'img-act';
    b.dataset.icon = '1';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = svg;
    b.addEventListener('click', () => onClick(b));
    return b;
  }

  const PROVIDERS = [
    { key: 'clickup', name: 'ClickUp', color: '#7B68EE', initials: 'CU', live: true },
    { key: 'jira', name: 'Jira', color: '#2684FF', initials: 'J', live: false },
    { key: 'linear', name: 'Linear', color: '#5E6AD2', initials: 'L', live: false },
  ];

  async function refreshClickup() {
    try { clickup = await (await fetch('/clickup/status')).json(); }
    catch { clickup = { configured: false, connected: false, teamName: null }; }
    renderIntgButton();
    if (!$('integrations-modal').hidden) renderIntgList();
  }

  // Disconnected leading icon (a link/chain glyph). Mirrors the inline SVG in
  // index.html so we can swap back to it after a disconnect.
  const CHAIN_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 9.5l-2 2a2.1 2.1 0 0 1-3-3l2-2"/><path d="M9.5 6.5l2-2a2.1 2.1 0 0 1 3 3l-2 2"/><path d="M6 10l4-4"/></svg>';

  function renderIntgButton() {
    const btn = $('integrations-btn');
    btn.querySelector('.dot')?.remove();
    if (clickup.connected) {
      // Connected → lead with the ClickUp glyph and a trailing live dot.
      $('intg-btn-icon').innerHTML = cuLogo(14, '#7B68EE');
      $('intg-btn-label').textContent = clickup.teamName ? `ClickUp · ${clickup.teamName}` : 'ClickUp connected';
      const dot = document.createElement('span'); dot.className = 'dot';
      btn.appendChild(dot);
    } else {
      $('intg-btn-icon').innerHTML = CHAIN_ICON;
      $('intg-btn-label').textContent = 'Connect';
    }
  }

  function renderIntgList() {
    const list = $('integrations-list');
    list.innerHTML = '';
    for (const p of PROVIDERS) {
      const row = document.createElement('div');
      row.className = 'intg-row' + (p.live ? '' : ' soon');
      const logo = document.createElement('div');
      logo.className = 'intg-logo'; logo.style.background = p.color;
      if (p.key === 'clickup') logo.innerHTML = cuLogo(17, '#fff');
      else logo.textContent = p.initials;
      const meta = document.createElement('div'); meta.className = 'intg-meta';
      const name = document.createElement('div'); name.className = 'intg-name'; name.textContent = p.name;
      const sub = document.createElement('div'); sub.className = 'intg-sub';
      meta.append(name, sub);
      row.append(logo, meta);

      if (!p.live) {
        sub.textContent = 'Create tickets from annotations';
        const badge = document.createElement('span'); badge.className = 'intg-badge'; badge.textContent = 'Coming soon';
        row.appendChild(badge);
      } else if (clickup.connected) {
        sub.textContent = clickup.teamName ? `Connected · ${clickup.teamName}` : 'Connected';
        const status = document.createElement('span'); status.className = 'intg-status';
        const dot = document.createElement('span'); dot.className = 'dot';
        status.append(dot, document.createTextNode('Connected'));
        const dis = document.createElement('button'); dis.textContent = 'Disconnect';
        dis.style.fontSize = '12px'; dis.style.padding = '6px 11px';
        dis.addEventListener('click', disconnectClickup);
        row.append(status, dis);
      } else {
        // Not connected: route to the token-first connect view (OAuth is
        // available there behind "Advanced", whether or not an app is configured).
        sub.textContent = 'Create tickets from annotations';
        const btn = document.createElement('button'); btn.className = 'primary'; btn.textContent = 'Connect';
        btn.addEventListener('click', renderClickupConnect);
        row.appendChild(btn);
      }
      list.appendChild(row);
    }
  }

  // First-run setup, shown inside the integrations modal when ClickUp has no
  // OAuth app configured yet. Walks through registering an app, shows the exact
  // Redirect URL to paste (port-correct), and collects the Client ID + Secret.
  // On save the creds go server-side and we drop straight into the OAuth popup.
  // Default connect view: paste a personal API token (pk_…). The breezy path —
  // no OAuth app, no popup. ClickUp's v2 API accepts a personal token in the
  // same Authorization header the OAuth token uses, so the server just
  // validates it against /team and connects. OAuth lives behind "Advanced".
  function renderClickupConnect() {
    $('integrations-list').innerHTML = `
      <div class="cu-setup">
        <button class="cu-back" id="cu-back" type="button">← All integrations</button>
        <p class="cu-lead">Paste your ClickUp API token — that's it, no app to register. Stored on this machine only, never in the browser or the repo.</p>
        <div class="tk-field">
          <label for="cu-token">ClickUp API token</label>
          <input id="cu-token" class="tk-input" type="password" placeholder="pk_••••••••••••" autocomplete="off" spellcheck="false">
        </div>
        <button class="primary cu-open" id="cu-get-token" type="button">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>
          Get your token from ClickUp
        </button>
        <p class="cu-help">It's at the top of ClickUp → <b>Settings → Apps</b>, under <b>API Token</b>. Hit <b>Copy</b> there, paste here.</p>
        <div class="tk-err" id="cu-tok-err"></div>
        <div class="modal-actions">
          <button id="cu-cancel" class="btn-ghost">Cancel</button>
          <button id="cu-tok-connect" class="primary">Connect</button>
        </div>
        <details class="cu-adv">
          <summary>Advanced: connect via an OAuth app instead</summary>
          <p class="cu-lead">OAuth lets each teammate approve with one click (no token to paste) and scopes access to just this app — at the cost of a one-time app registration.</p>
          <button id="cu-adv-go" class="btn-ghost">${clickup.configured ? 'Connect via OAuth' : 'Set up OAuth app'}</button>
        </details>
      </div>`;
    $('cu-back').addEventListener('click', renderIntgList);
    $('cu-cancel').addEventListener('click', renderIntgList);
    $('cu-get-token').addEventListener('click', () => window.open('https://app.clickup.com/settings/apps', '_blank', 'noopener'));
    $('cu-tok-connect').addEventListener('click', connectClickupToken);
    $('cu-adv-go').addEventListener('click', () => (clickup.configured ? connectClickup() : renderClickupSetup()));
    $('cu-token').addEventListener('keydown', (e) => { if (e.key === 'Enter') connectClickupToken(); });
    setTimeout(() => $('cu-token').focus(), 0);
  }

  async function connectClickupToken() {
    const token = $('cu-token').value.trim();
    const err = $('cu-tok-err'); err.textContent = '';
    if (!token) { err.textContent = 'Paste your ClickUp API token first.'; return; }
    const btn = $('cu-tok-connect'); btn.disabled = true; btn.textContent = 'Connecting…';
    try {
      const r = await fetch('/clickup/token', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.error) throw new Error(data.error || ('http ' + r.status));
      await refreshClickup();
      toast(data.teamName ? `ClickUp connected · ${data.teamName}` : 'ClickUp connected');
      renderIntgList();
    } catch (e) {
      err.textContent = /invalid token/i.test(e.message)
        ? 'That token didn’t work — check you copied the full pk_… value.'
        : 'Connect failed: ' + e.message;
      btn.disabled = false; btn.textContent = 'Connect';
    }
  }

  function renderClickupSetup() {
    const redirect = clickup.redirectUri || (location.origin + '/clickup/callback');
    $('integrations-list').innerHTML = `
      <div class="cu-setup">
        <button class="cu-back" id="cu-back" type="button">← All integrations</button>
        <p class="cu-lead">One-time, ~2 min. Open ClickUp's Apps page, create an app, paste its two keys back here. They're stored on this machine only — never in the browser or the repo.</p>
        <button class="primary cu-open" id="cu-open" type="button">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>
          Open ClickUp Apps page
        </button>
        <p class="cu-or">then, in ClickUp:</p>
        <ol class="cu-steps">
          <li>Click <b>Create new app</b> — name it <b>Jelly Local Sync</b> (or anything).</li>
          <li>Set its <b>Redirect URL</b> to exactly this:
            <div class="cu-redirect"><code id="cu-redirect">${escapeHtml(redirect)}</code><button id="cu-copy" type="button">Copy</button></div>
          </li>
          <li>It generates a <b>Client ID</b> and <b>Secret</b> — paste them below.</li>
        </ol>
        <div class="tk-field"><label for="cu-id">Client ID</label><input id="cu-id" class="tk-input" type="text" placeholder="ABCDEF..." autocomplete="off" spellcheck="false"></div>
        <div class="tk-field"><label for="cu-secret">Client Secret</label><input id="cu-secret" class="tk-input" type="password" placeholder="••••••••" autocomplete="off" spellcheck="false"></div>
        <div class="tk-err" id="cu-err"></div>
        <div class="modal-actions">
          <button id="cu-cancel" class="btn-ghost">Cancel</button>
          <button id="cu-save" class="primary">Save &amp; Connect</button>
        </div>
      </div>`;
    $('cu-back').addEventListener('click', renderIntgList);
    $('cu-cancel').addEventListener('click', renderIntgList);
    // Deep-link straight to ClickUp's Apps settings, skipping the menu hunt.
    // Opens in a new tab; if ClickUp lands the user on their workspace home
    // instead, the numbered steps below still guide them to Create new app.
    $('cu-open').addEventListener('click', () => {
      window.open('https://app.clickup.com/settings/apps', '_blank', 'noopener');
      copy(redirect, $('cu-copy'));   // pre-copy the redirect URL so it's ready to paste
    });
    $('cu-copy').addEventListener('click', () => copy(redirect, $('cu-copy')));
    $('cu-save').addEventListener('click', saveClickupConfig);
    setTimeout(() => $('cu-id').focus(), 0);
  }

  async function saveClickupConfig() {
    const client_id = $('cu-id').value.trim();
    const client_secret = $('cu-secret').value.trim();
    const err = $('cu-err'); err.textContent = '';
    if (!client_id || !client_secret) { err.textContent = 'Both Client ID and Secret are required.'; return; }
    const btn = $('cu-save'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const r = await fetch('/clickup/config', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id, client_secret }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.error) throw new Error(data.error || ('http ' + r.status));
      await refreshClickup();   // configured is now true
      connectClickup();         // straight into the one-click OAuth popup
      renderIntgList();         // back to the list (flips to Connected on success)
    } catch (e) {
      err.textContent = 'Save failed: ' + e.message;
      btn.disabled = false; btn.textContent = 'Save & Connect';
    }
  }

  // Open the consent screen in a popup. Because the user is already logged in on
  // app.clickup.com, ClickUp shows a one-click Allow; the callback page closes
  // itself and postMessages us. Falls back to a toast if the popup is blocked.
  function connectClickup(btn) {
    const w = 600, h = 720;
    const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2);
    const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2);
    const popup = window.open('/clickup/auth', 'jelly-clickup', `width=${w},height=${h},left=${left},top=${top}`);
    if (!popup) { toast('Popup blocked — allow popups and retry'); return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Waiting…'; }
  }

  function disconnectClickup() {
    fetch('/clickup/disconnect', { method: 'POST' })
      .then(() => { toast('ClickUp disconnected'); refreshClickup(); })
      .catch(() => toast('Disconnect failed'));
  }

  window.addEventListener('message', (e) => {
    if (e.data?.source !== 'jelly-clickup') return;
    toast(e.data.ok ? 'ClickUp connected' : 'ClickUp connection failed');
    refreshClickup();
  });

  function openIntegrations() {
    renderIntgList();
    $('integrations-modal').hidden = false;
    setTimeout(() => $('integrations-close').focus(), 0);
    refreshClickup();
  }
  function closeIntegrations() { $('integrations-modal').hidden = true; }
  $('integrations-btn').addEventListener('click', openIntegrations);
  $('integrations-close').addEventListener('click', closeIntegrations);
  $('integrations-modal').addEventListener('click', (e) => { if (e.target === $('integrations-modal')) closeIntegrations(); });

  // ── Create ClickUp ticket from one annotation ────────────────────────────
  let ticketState = null;

  function openTicketModal(a, index) {
    if (!clickup.connected) { toast('Connect ClickUp first'); openIntegrations(); return; }
    ticketState = { a, index };
    const defaultName = ((a.comment || '').trim().split('\n')[0] || a.element || 'QA annotation').slice(0, 120);
    $('ticket-mount').innerHTML = `
      <h3 class="modal-title cu-title">${cuLogo(18, '#7B68EE')}<span>Create ClickUp ticket</span></h3>
      <div class="tk-form">
        <div class="tk-field">
          <label>Type</label>
          <div class="tk-seg" id="tk-type">
            <button type="button" data-type="task" class="active">Task</button>
            <button type="button" data-type="bug">Bug</button>
          </div>
        </div>
        <div class="tk-field">
          <label for="tk-space">Space</label>
          <select id="tk-space" class="tk-select"><option value="">Loading spaces…</option></select>
        </div>
        <div class="tk-field">
          <label for="tk-list">List</label>
          <select id="tk-list" class="tk-select" disabled><option value="">Select a space first</option></select>
        </div>
        <div class="tk-field">
          <label for="tk-name">Title</label>
          <input id="tk-name" class="tk-input" type="text" value="${escapeHtml(defaultName)}">
        </div>
        <div class="tk-err" id="tk-err"></div>
        <div class="modal-actions">
          <button id="tk-cancel" class="btn-ghost">Cancel</button>
          <button id="tk-create" class="primary">Create ticket</button>
        </div>
      </div>`;
    const seg = $('tk-type');
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-type]'); if (!b) return;
      seg.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    });
    $('tk-cancel').addEventListener('click', closeTicketModal);
    $('tk-create').addEventListener('click', submitTicket);
    $('tk-space').addEventListener('change', () => loadLists($('tk-space').value));
    $('ticket-modal').hidden = false;
    setTimeout(() => $('tk-name').focus(), 0);
    loadSpaces();
  }
  function closeTicketModal() { $('ticket-modal').hidden = true; $('ticket-mount').innerHTML = ''; ticketState = null; }
  function tkError(msg) { const e = $('tk-err'); if (e) e.textContent = msg || ''; }

  async function loadSpaces() {
    const sel = $('tk-space');
    try {
      const r = await fetch('/clickup/spaces');
      if (r.status === 401) { tkError('ClickUp session expired — reconnect from Connect.'); return; }
      const { spaces = [], error } = await r.json();
      if (error) { tkError(error); return; }
      sel.innerHTML = spaces.length
        ? '<option value="">Select a space…</option>' + spaces.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('')
        : '<option value="">No spaces found</option>';
    } catch { tkError('Could not load spaces.'); }
  }

  async function loadLists(spaceId) {
    const sel = $('tk-list');
    tkError('');
    if (!spaceId) { sel.disabled = true; sel.innerHTML = '<option value="">Select a space first</option>'; return; }
    sel.disabled = true; sel.innerHTML = '<option value="">Loading lists…</option>';
    try {
      const { lists = [], error } = await (await fetch('/clickup/lists?space_id=' + encodeURIComponent(spaceId))).json();
      if (error) { tkError(error); sel.innerHTML = '<option value="">—</option>'; return; }
      if (!lists.length) { sel.innerHTML = '<option value="">No lists in this space</option>'; return; }
      sel.innerHTML = '<option value="">Select a list…</option>' + lists.map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`).join('');
      sel.disabled = false;
    } catch { tkError('Could not load lists.'); sel.innerHTML = '<option value="">—</option>'; }
  }

  // ClickUp priority: 1 urgent, 2 high, 3 normal, 4 low. Map from QA severity.
  function severityToPriority(sev) {
    switch ((sev || '').toLowerCase()) {
      case 'critical': case 'blocker': return 1;
      case 'high': case 'major': return 2;
      case 'low': case 'minor': case 'trivial': return 4;
      default: return 3;
    }
  }

  async function submitTicket() {
    if (!ticketState?.a) return;
    const { a, index } = ticketState;
    const listId = $('tk-list').value;
    const name = $('tk-name').value.trim();
    const type = $('tk-type').querySelector('button.active')?.dataset.type || 'task';
    tkError('');
    if (!listId) { tkError('Pick a list.'); return; }
    if (!name) { tkError('Title can’t be empty.'); return; }
    const btn = $('tk-create'); btn.disabled = true; btn.textContent = 'Creating…';
    try {
      const r = await fetch('/clickup/task', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          list_id: listId, type, name,
          markdown: annotationMarkdown(a, index ?? 0),
          priority: severityToPriority(a.severity),
          roomToken: TOKEN, annotationId: a.id,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.error) throw new Error(data.error || ('http ' + r.status));
      renderTicketSuccess(type, data.url, data.attached);
    } catch (e) {
      tkError('Create failed: ' + e.message);
      btn.disabled = false; btn.textContent = 'Create ticket';
    }
  }

  function renderTicketSuccess(type, url, attached) {
    $('ticket-mount').innerHTML = `
      <div class="tk-success">
        <div class="ico">✅</div>
        <p>${type === 'bug' ? 'Bug' : 'Task'} created in ClickUp${attached ? ' with the screenshot attached' : ''}.</p>
        <div class="modal-actions" style="justify-content: center;">
          <button id="tk-done" class="btn-ghost">Done</button>
          <button id="tk-open" class="primary">Open in ClickUp</button>
        </div>
      </div>`;
    $('tk-done').addEventListener('click', closeTicketModal);
    $('tk-open').addEventListener('click', () => { window.open(url, '_blank'); closeTicketModal(); });
    setTimeout(() => $('tk-open').focus(), 0);
  }
  $('ticket-close').addEventListener('click', closeTicketModal);
  $('ticket-modal').addEventListener('click', (e) => { if (e.target === $('ticket-modal')) closeTicketModal(); });

  // ── Bulk: create one ClickUp ticket per visible annotation ────────────────
  // Reuses the same /clickup/spaces · /clickup/lists · /clickup/task endpoints
  // as the single-ticket flow; one destination (space + list + type) applies to
  // every selected annotation. Creation is sequential with a live progress
  // count, so a mid-run failure doesn't lose the tickets already created.
  let bulkItems = [];
  let bulkSelected = new Set();

  async function cuFetchSpaces() {
    const r = await fetch('/clickup/spaces');
    if (r.status === 401) throw new Error('ClickUp session expired — reconnect from Connect.');
    const { spaces = [], error } = await r.json();
    if (error) throw new Error(error);
    return spaces;
  }
  async function cuFetchLists(spaceId) {
    const { lists = [], error } = await (await fetch('/clickup/lists?space_id=' + encodeURIComponent(spaceId))).json();
    if (error) throw new Error(error);
    return lists;
  }
  function bkError(m) { const e = $('bk-err'); if (e) e.textContent = m || ''; }

  function openBulkModal() {
    if (!clickup.connected) { toast('Connect ClickUp first'); openIntegrations(); return; }
    bulkItems = visibleAnnotations();
    if (!bulkItems.length) { toast('No annotations to ticket'); return; }
    bulkSelected = new Set(bulkItems.map((x) => x.id));   // all selected by default
    $('bulk-mount').innerHTML = `
      <h3 class="modal-title cu-title">${cuLogo(18, '#7B68EE')}<span>Create ClickUp tickets</span></h3>
      <p class="bulk-dest">Destination: <b>ClickUp · ${escapeHtml(clickup.teamName || 'workspace')}</b>. One ticket per selected annotation.</p>
      <div class="tk-form">
        <div class="tk-field">
          <label>Type</label>
          <div class="tk-seg" id="bk-type">
            <button type="button" data-type="task" class="active">Task</button>
            <button type="button" data-type="bug">Bug</button>
          </div>
        </div>
        <div class="tk-field">
          <label for="bk-space">Space</label>
          <select id="bk-space" class="tk-select"><option value="">Loading spaces…</option></select>
        </div>
        <div class="tk-field">
          <label for="bk-list">List</label>
          <select id="bk-list" class="tk-select" disabled><option value="">Select a space first</option></select>
        </div>
        <div class="tk-field">
          <label>Annotations <span class="bulk-count" id="bk-count"></span></label>
          <div class="bulk-list" id="bk-items"></div>
        </div>
        <div class="tk-err" id="bk-err"></div>
        <div class="modal-actions">
          <button id="bk-cancel" class="btn-ghost">Cancel</button>
          <button id="bk-create" class="primary">Create tickets</button>
        </div>
      </div>`;
    const seg = $('bk-type');
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-type]'); if (!b) return;
      seg.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    });
    $('bk-cancel').addEventListener('click', closeBulkModal);
    $('bk-create').addEventListener('click', submitBulk);
    $('bk-space').addEventListener('change', () => bulkLoadLists($('bk-space').value));
    renderBulkItems();
    $('bulk-modal').hidden = false;
    bulkLoadSpaces();
  }

  function renderBulkItems() {
    const wrap = $('bk-items');
    wrap.innerHTML = '';
    for (const { id, a } of bulkItems) {
      const row = document.createElement('label');
      row.className = 'bulk-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = bulkSelected.has(id);
      cb.addEventListener('change', () => { cb.checked ? bulkSelected.add(id) : bulkSelected.delete(id); updateBulkCount(); });
      const txt = document.createElement('span');
      txt.className = 'bi-txt';
      txt.textContent = ((a.comment || '').trim().split('\n')[0] || a.element || 'QA annotation').slice(0, 90);
      row.append(cb, txt);
      wrap.appendChild(row);
    }
    updateBulkCount();
  }
  function updateBulkCount() {
    const n = bulkSelected.size;
    const c = $('bk-count'); if (c) c.textContent = `(${n} of ${bulkItems.length} selected)`;
    const btn = $('bk-create'); if (btn && !btn.disabled) btn.textContent = n ? `Create ${n} ticket${n === 1 ? '' : 's'}` : 'Create tickets';
  }

  async function bulkLoadSpaces() {
    const sel = $('bk-space');
    try {
      const spaces = await cuFetchSpaces();
      sel.innerHTML = spaces.length
        ? '<option value="">Select a space…</option>' + spaces.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('')
        : '<option value="">No spaces found</option>';
    } catch (e) { bkError(e.message); }
  }
  async function bulkLoadLists(spaceId) {
    const sel = $('bk-list'); bkError('');
    if (!spaceId) { sel.disabled = true; sel.innerHTML = '<option value="">Select a space first</option>'; return; }
    sel.disabled = true; sel.innerHTML = '<option value="">Loading lists…</option>';
    try {
      const lists = await cuFetchLists(spaceId);
      if (!lists.length) { sel.innerHTML = '<option value="">No lists in this space</option>'; return; }
      sel.innerHTML = '<option value="">Select a list…</option>' + lists.map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`).join('');
      sel.disabled = false;
    } catch (e) { bkError(e.message); sel.innerHTML = '<option value="">—</option>'; }
  }

  async function submitBulk() {
    const listId = $('bk-list').value;
    const type = $('bk-type').querySelector('button.active')?.dataset.type || 'task';
    bkError('');
    if (!listId) { bkError('Pick a list.'); return; }
    const chosen = bulkItems.filter((x) => bulkSelected.has(x.id));
    if (!chosen.length) { bkError('Select at least one annotation.'); return; }
    const btn = $('bk-create'); btn.disabled = true;
    const cancel = $('bk-cancel'); if (cancel) cancel.disabled = true;
    let ok = 0; const fails = [];
    for (let i = 0; i < chosen.length; i++) {
      const { a, index } = chosen[i];
      btn.textContent = `Creating ${i + 1}/${chosen.length}…`;
      try {
        const r = await fetch('/clickup/task', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            list_id: listId, type,
            name: ((a.comment || '').trim().split('\n')[0] || a.element || 'QA annotation').slice(0, 120),
            markdown: annotationMarkdown(a, index ?? 0),
            priority: severityToPriority(a.severity),
            roomToken: TOKEN, annotationId: a.id,
          }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || data.error) throw new Error(data.error || ('http ' + r.status));
        ok++;
      } catch (e) { fails.push(e.message); }
    }
    renderBulkSummary(ok, chosen.length, type);
  }

  function renderBulkSummary(ok, total, type) {
    const failed = total - ok;
    $('bulk-mount').innerHTML = `
      <div class="tk-success">
        <div class="ico">${failed ? '⚠️' : '✅'}</div>
        <p>${ok} ${type === 'bug' ? 'bug' : 'task'}${ok === 1 ? '' : 's'} created in ClickUp${failed ? `, ${failed} failed` : ''}.</p>
        <div class="modal-actions" style="justify-content: center;">
          <button id="bk-done" class="primary">Done</button>
        </div>
      </div>`;
    $('bk-done').addEventListener('click', closeBulkModal);
    setTimeout(() => $('bk-done').focus(), 0);
  }

  function closeBulkModal() {
    $('bulk-modal').hidden = true; $('bulk-mount').innerHTML = '';
    bulkItems = []; bulkSelected = new Set();
  }

  $('bulk-create').innerHTML = cuLogo(14, 'currentColor') + '<span>Create multiple tickets</span>';
  $('bulk-create').addEventListener('click', openBulkModal);
  $('bulk-close').addEventListener('click', closeBulkModal);
  $('bulk-modal').addEventListener('click', (e) => { if (e.target === $('bulk-modal')) closeBulkModal(); });

  // ── Troubleshooter ───────────────────────────────────────────────────────
  // A two-sided connection diagnostic. The laptop self-checks what it can see
  // (LAN address, server binding, VPN noise, SSE, self-reachability); then a
  // QR points the phone at /diag, which probes every candidate address and
  // reports back over SSE which ones it could reach, the definitive signal the
  // laptop can't observe on its own. Whatever the phone reaches is auto-selected
  // as the advertised address.
  let onDiagReport = null;   // set while the troubleshooter waits for a phone report
  let diagTimer = null;
  const VIRTUAL_IFACE = /^(utun|tun|tap|ppp|ipsec|wg|gpd|docker|veth|br-|bridge|vboxnet|vmnet|vmware|vnic|virbr|llw|awdl|gif|stf|anpi|ap\d)/i;
  const TS_ICON = { pass: '✓', warn: '!', fail: '✕', info: 'i', pending: '' };

  const TS_HTML = `
    <div class="ts-root">
      <div class="ts-head"><h3 class="modal-title">Troubleshoot connection</h3></div>
      <p class="ts-intro">Find why a device can't connect. We check this laptop's setup, then your phone tests whether it can actually reach the laptop, no app needed.</p>
      <button class="primary ts-run" type="button">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 3.2v9.6a.5.5 0 0 0 .77.42l7.2-4.8a.5.5 0 0 0 0-.84l-7.2-4.8A.5.5 0 0 0 4 3.2z"/></svg>
        <span class="ts-run-label">Run checks</span>
      </button>
      <div class="ts-results" hidden>
        <div class="ts-section-label">This laptop</div>
        <div class="ts-checks ts-self"></div>
        <div class="ts-section-label">Your phone</div>
        <div class="ts-probe">
          <div class="ts-probe-qr"><canvas aria-label="QR to the phone connection test"></canvas></div>
          <div class="ts-probe-text"><h4>Test from the phone</h4><p></p></div>
        </div>
        <div class="ts-probe-results" hidden></div>
      </div>
    </div>`;

  function tsAddCheck(container, c) {
    const el = document.createElement('div');
    el.className = 'ts-check';
    container.appendChild(el);
    tsUpdateCheck(el, c);
    return el;
  }
  function tsUpdateCheck(el, c) {
    el.innerHTML = `<div class="ts-check-row"><span class="ts-ico ${c.status}">${TS_ICON[c.status] || ''}</span><span class="ts-label"></span></div>`;
    el.querySelector('.ts-label').textContent = c.label;
    if (c.detail) { const d = document.createElement('div'); d.className = 'ts-detail'; d.textContent = c.detail; el.appendChild(d); }
    if (c.fix) { const f = document.createElement('div'); f.className = 'ts-fix'; f.innerHTML = c.fix; el.appendChild(f); }
  }

  function tsPing(ip) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 3000);
    return fetch(`http://${ip}:${PORT}/ping`, { signal: ctrl.signal, cache: 'no-store' })
      .then((r) => r.ok).catch(() => false).then((v) => { clearTimeout(to); return v; });
  }

  function tsRunSelfChecks(container) {
    container.innerHTML = '';

    if (!LAN_IPS.length) {
      tsAddCheck(container, { status: 'fail', label: 'No LAN address detected',
        detail: "The server has no Wi-Fi/Ethernet address, so phones can't reach it over Wi-Fi.",
        fix: '<p>The laptop is offline, on no network, or the server was bound to localhost. Connect to Wi-Fi and refresh this page. For wired QA, use Android over USB with <code>adb reverse</code>.</p>' });
    } else {
      tsAddCheck(container, { status: 'pass', label: 'LAN address detected',
        detail: (LAN_IPS.length > 1 ? `Found ${LAN_IPS.length} addresses; advertising ` : 'Advertising ') + `${LAN_IPS[0].ip} (${LAN_IPS[0].iface}).` });
    }

    const allIfaces = (BOUND_HOST === '0.0.0.0' || BOUND_HOST === '::' || BOUND_HOST === '');
    if (allIfaces) {
      tsAddCheck(container, { status: 'pass', label: 'Listening on all interfaces', detail: `Bound to ${BOUND_HOST || '0.0.0.0'}, it accepts LAN connections.` });
    } else if (BOUND_HOST === '127.0.0.1' || BOUND_HOST === 'localhost' || BOUND_HOST === '::1') {
      tsAddCheck(container, { status: 'fail', label: 'Server bound to localhost',
        detail: `Started with HOST=${BOUND_HOST}, so it only accepts connections from this machine. No phone can reach it.`,
        fix: '<p>Restart without the localhost bind, <code>node server.mjs</code> defaults to <code>HOST=0.0.0.0</code>.</p>' });
    } else {
      tsAddCheck(container, { status: 'warn', label: 'Bound to a single interface',
        detail: `Started with HOST=${BOUND_HOST}. Only that interface accepts connections, make sure it's the one your phone is on.` });
    }

    const virtual = LAN_IPS.filter((c) => VIRTUAL_IFACE.test(c.iface));
    if (virtual.length) {
      const onlyVirtual = virtual.length === LAN_IPS.length;
      tsAddCheck(container, { status: onlyVirtual ? 'warn' : 'info',
        label: onlyVirtual ? 'Only VPN/virtual networks found' : 'VPN/virtual interfaces present',
        detail: virtual.map((v) => `${v.ip} (${v.iface})`).join(', ') + ", phones can't route to these.",
        fix: onlyVirtual
          ? '<p>The only addresses found are VPN/virtual adapters. Disconnect the VPN or connect the laptop to normal Wi-Fi, then refresh.</p>'
          : "<p>These appear in the address picker but won't work for a phone. Pick a <b>192.168.x</b> or <b>10.x</b> address matching your phone's Wi-Fi.</p>" });
    }

    tsAddCheck(container, sseConnected
      ? { status: 'pass', label: 'Realtime stream connected', detail: 'This dashboard is receiving live updates from the server.' }
      : { status: 'fail', label: 'Realtime stream down', detail: "This dashboard isn't connected to the server.",
          fix: '<p>The server may have restarted. Refresh this page to start a fresh session.</p>' });

    if (devices.size) {
      tsAddCheck(container, { status: 'pass', label: `${devices.size} device${devices.size > 1 ? 's' : ''} already connected`, detail: 'At least one device has reached the server, pairing works.' });
    } else {
      tsAddCheck(container, { status: 'info', label: 'No device has connected yet', detail: 'Use the phone test below to check whether a device can reach this laptop.' });
    }

    if (LAN_IPS.length) {
      const row = tsAddCheck(container, { status: 'pending', label: 'Testing reachability from this browser…' });
      tsPing(LAN_IPS[0].ip).then((ok) => {
        if (ok) tsUpdateCheck(row, { status: 'pass', label: 'Server reachable on its LAN address', detail: `This browser reached ${LAN_IPS[0].ip}:${PORT}, the server is listening on that interface.` });
        else tsUpdateCheck(row, { status: 'fail', label: "Can't reach the server on its LAN address",
          detail: `This browser couldn't reach ${LAN_IPS[0].ip}:${PORT}. If even this machine can't, no phone can.`,
          fix: `<p>Likely a <b>firewall</b> blocking the port (or the server bound to localhost). If you control it, macOS: allow incoming for <code>node</code> in <b>System Settings → Network → Firewall</b>; Windows: approve <b>Node.js</b> on <b>Private networks</b>.</p><p><b>Firewall locked by an MDM?</b> You can't open it, but <b>Android over USB routes around it</b>, the tunnel sits below the IP layer the firewall inspects. Run <code>adb reverse tcp:${PORT} tcp:${PORT}</code> and paste the <b>Endpoint URL</b> (the localhost one, not the LAN URL). iOS has no equivalent, it needs an IT/MDM exception or an unmanaged laptop on the same Wi-Fi.</p>` });
      });
    }
  }

  function tsRenderProbeResults(resultsEl, data) {
    clearTimeout(diagTimer);
    const results = (data && data.report && data.report.results) || [];
    const ua = (data && data.report && data.report.ua) || '';
    const phone = /iphone|ipad/i.test(ua) ? 'iPhone' : /android/i.test(ua) ? 'Android device' : 'The phone';
    resultsEl.hidden = false;
    resultsEl.innerHTML = '';
    results.slice().sort((a, b) => (b.ok ? 1 : 0) - (a.ok ? 1 : 0)).forEach((r) => {
      const el = document.createElement('div');
      el.className = 'ts-pr ' + (r.ok ? 'ok' : 'bad');
      el.innerHTML = '<span class="dot"></span><span class="ip"></span><span class="verdict"></span>';
      el.querySelector('.ip').textContent = r.ip + (r.iface ? ` · ${r.iface}` : '');
      el.querySelector('.verdict').textContent = r.ok ? `reachable · ${r.ms}ms` : 'no route';
      if (r.ok) {
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'pick';
        btn.textContent = r.ip === lanIpSel ? 'in use' : 'use this';
        btn.addEventListener('click', () => {
          applyLanIp(r.ip);
          resultsEl.querySelectorAll('.pick').forEach((b) => { b.textContent = 'use this'; });
          btn.textContent = 'in use';
          toast(`Now advertising ${r.ip}`);
        });
        el.appendChild(btn);
      }
      resultsEl.appendChild(el);
    });
    const reachable = results.filter((r) => r.ok);
    if (reachable.length && !reachable.some((r) => r.ip === lanIpSel)) applyLanIp(reachable[0].ip);
    const note = document.createElement('div');
    note.className = 'ts-fix';
    if (reachable.length) {
      note.innerHTML = `<p><b>${phone} can reach this laptop on ${reachable[0].ip}.</b> The connect QR now uses that address, re-scan it, or paste the LAN URL into the Jelly toolbar.</p>`;
    } else {
      note.innerHTML = `<p><b>${phone} loaded the test but reached no address back.</b> Unusual, usually a firewall or isolation rule that allowed the page but blocks the API port. Check the laptop firewall, or use Android over USB.</p>`;
    }
    resultsEl.appendChild(note);
  }

  function tsStartPhoneProbe(mount) {
    const probe = mount.querySelector('.ts-probe');
    const resultsEl = mount.querySelector('.ts-probe-results');
    const para = probe.querySelector('.ts-probe-text p');
    resultsEl.hidden = true;
    resultsEl.innerHTML = '';
    const ip = LAN_IPS[0] && LAN_IPS[0].ip;
    if (ip && renderQR(probe.querySelector('canvas'), `http://${ip}:${PORT}/diag?t=${TOKEN}`, 4)) {
      para.textContent = "Scan with the phone you're connecting. It tests every address and reports back here in a few seconds.";
    } else {
      para.textContent = 'No LAN address to test from. Connect the laptop to Wi-Fi and refresh.';
      return;
    }
    clearTimeout(diagTimer);
    onDiagReport = (data) => tsRenderProbeResults(resultsEl, data);
    diagTimer = setTimeout(() => {
      if (resultsEl.hasChildNodes()) return;
      resultsEl.hidden = false;
      const el = document.createElement('div');
      el.className = 'ts-pr bad';
      el.innerHTML = '<span class="dot"></span><span class="ip">No response from the phone</span>';
      resultsEl.appendChild(el);
      const fix = document.createElement('div');
      fix.className = 'ts-fix';
      fix.innerHTML = `<p>The phone hasn't reported in. If it can't even load the test page, it can't reach this laptop at all, that points to <b>different Wi-Fi networks</b>, <b>client isolation</b> (guest/corporate Wi-Fi), a <b>firewall</b>, or an <b>MDM</b> policy blocking local network.</p><p>Confirm the phone is on the same Wi-Fi and scan again. On Android, bypass Wi-Fi with USB: <code>adb reverse tcp:${PORT} tcp:${PORT}</code>.</p>`;
      resultsEl.appendChild(fix);
    }, 35000);
  }

  function buildTroubleshooter() {
    const root = document.createElement('div');
    root.innerHTML = TS_HTML;
    const mount = root.firstElementChild;
    const runBtn = mount.querySelector('.ts-run');
    const results = mount.querySelector('.ts-results');
    runBtn.addEventListener('click', () => {
      results.hidden = false;
      runBtn.querySelector('.ts-run-label').textContent = 'Re-run checks';
      tsRunSelfChecks(mount.querySelector('.ts-self'));
      tsStartPhoneProbe(mount);
    });
    return mount;
  }

  function openTroubleshoot() {
    const mount = $('troubleshoot-mount');
    mount.innerHTML = '';
    mount.appendChild(buildTroubleshooter());
    $('troubleshoot-modal').hidden = false;
    setTimeout(() => $('troubleshoot-close').focus(), 0);
  }
  function closeTroubleshoot() {
    $('troubleshoot-modal').hidden = true;
    $('troubleshoot-mount').innerHTML = '';
    onDiagReport = null;
    clearTimeout(diagTimer);
  }
  $('troubleshoot-btn').addEventListener('click', openTroubleshoot);
  $('troubleshoot-close').addEventListener('click', closeTroubleshoot);
  $('troubleshoot-modal').addEventListener('click', (e) => { if (e.target === $('troubleshoot-modal')) closeTroubleshoot(); });

  // ── State ──────────────────────────────────────────────────────────────
  const annotations = new Map();   // id -> annotation
  const order = [];                // ids, oldest first; rendered newest-first
  const imagesPresent = new Set(); // ids with an uploaded image
  const devices = new Map();       // key -> device (with lastSeenLocalMs)
  const deviceColorIdx = new Map();// key -> palette index (stable per device)
  let filterKey = null;            // null = show all devices
  let sseConnected = false;
  let renderedIds = new Set();     // ids currently in the DOM (animate only-new)

  const FRESH_MS = 18_000;         // within this of last heartbeat → "Connected"
  // Distinct, dark-bg-friendly colours assigned in device arrival order.
  const PALETTE = ['#84cc16', '#38bdf8', '#f59e0b', '#f472b6', '#a78bfa', '#2dd4bf', '#fb7185', '#facc15', '#60a5fa', '#34d399'];
  function colorFor(key) {
    if (!deviceColorIdx.has(key)) deviceColorIdx.set(key, deviceColorIdx.size % PALETTE.length);
    return PALETTE[deviceColorIdx.get(key)];
  }

  function deviceLabel(d) {
    if (!d) return 'Unknown device';
    const name = d.model || d.manufacturer || (d.platform && d.platform !== 'unknown'
      ? d.platform[0].toUpperCase() + d.platform.slice(1) : 'Unknown device');
    const os = d.osVersion
      ? (d.platform === 'android' ? 'Android ' + d.osVersion
        : d.platform === 'ios' ? 'iOS ' + d.osVersion
        : d.osVersion)
      : null;
    return os ? `${name} · ${os}` : name;
  }
  function platformTag(d) {
    const p = d?.platform;
    if (!p || p === 'unknown') return '';
    return p === 'ios' ? 'iOS' : p[0].toUpperCase() + p.slice(1);
  }
  function deviceInitial(d) {
    const s = d?.model || d?.manufacturer || d?.platform || '?';
    return s[0]?.toUpperCase() ?? '?';
  }

  function relTime(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    return h + 'h ago';
  }

  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(typeof ts === 'number' ? ts : ts);
    if (Number.isNaN(d.getTime())) return '';
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  // Mirrors OutputGenerator's Standard markdown so downstream agents read either source.
  function annotationMarkdown(a, index) {
    const lines = [];
    lines.push(`### ${index + 1}. ${a.element ?? 'Element'}`);
    const dev = devices.get(a._deviceKey) || a._device;
    if (dev) lines.push(`**Device:** ${deviceLabel(dev)}`);
    if (a.elementPath) lines.push(`**Location:** ${a.elementPath}`);
    if (a.sourceFile) lines.push(`**Source:** ${a.sourceFile}`);
    if (a.reactComponents) lines.push(`**Composables:** ${a.reactComponents}`);
    if (a.selectedText) lines.push(`**Selected text:** "${a.selectedText}"`);
    if (a.intent) lines.push(`**Intent:** ${a.intent}`);
    if (a.severity) lines.push(`**Severity:** ${a.severity}`);
    if (imagesPresent.has(a.id)) lines.push(`**Screenshot:** [attached]`);
    lines.push(`**Feedback:** ${a.comment ?? ''}`);
    return lines.join('\n');
  }

  // Annotations attributed to a device key (server stamps _deviceKey).
  function countFor(key) {
    let n = 0;
    for (const id of order) if (annotations.get(id)?._deviceKey === key) n++;
    return n;
  }

  // ── Device upsert + rendering ───────────────────────────────────────────
  // Anchor server time against the local clock so liveness dodges clock skew.
  function upsertDevice(d, serverNow) {
    if (!d?.key) return;
    const prev = devices.get(d.key);
    const lastSeenLocalMs = (d.lastHelloMs && serverNow)
      ? Date.now() - Math.max(0, serverNow - d.lastHelloMs)
      : (prev?.lastSeenLocalMs ?? null);
    devices.set(d.key, { ...prev, ...d, lastSeenLocalMs });
    colorFor(d.key);
  }

  function deviceStatus(d) {
    if (d.lastSeenLocalMs == null) return { cls: 'stale', text: 'No heartbeat yet' };
    const age = Date.now() - d.lastSeenLocalMs;
    if (age < FRESH_MS) return { cls: 'live pulse', text: 'Connected' };
    return { cls: 'stale', text: 'Last seen ' + relTime(age) };
  }

  function renderDevices() {
    syncMainView();
    const list = $('device-list');
    const ds = [...devices.values()].sort((a, b) => (a.firstSeenMs ?? 0) - (b.firstSeenMs ?? 0));
    $('device-count').textContent = ds.length ? String(ds.length) : '';
    list.innerHTML = '';
    if (!ds.length) {
      const empty = document.createElement('div');
      empty.className = 'device-empty';
      empty.innerHTML = sseConnected
        ? '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3M21 21v.01M21 14v.01M14 21v.01"/></svg><span>Scan your QR code to connect a device.</span>'
        : 'Reconnecting to the server…';
      list.appendChild(empty);
      return;
    }
    for (const d of ds) {
      const color = colorFor(d.key);
      const st = deviceStatus(d);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'device-row' + (filterKey === d.key ? ' active' : '');
      row.dataset.key = d.key;

      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = color;
      swatch.textContent = deviceInitial(d);
      const dot = document.createElement('span');
      dot.className = 'live-dot ' + st.cls;
      swatch.appendChild(dot);

      const meta = document.createElement('span');
      meta.className = 'device-meta';
      const name = document.createElement('div');
      name.className = 'device-name';
      name.textContent = deviceLabel(d);
      const sub = document.createElement('div');
      sub.className = 'device-sub';
      sub.textContent = st.text;
      meta.append(name, sub);

      const tally = document.createElement('span');
      tally.className = 'device-tally';
      tally.textContent = countFor(d.key);

      row.append(swatch, meta, tally);
      row.addEventListener('click', () => setFilter(filterKey === d.key ? null : d.key));
      list.appendChild(row);
    }
  }

  // Lightweight per-second tick: update status text + dot without rebuilding
  // (rebuilding would restart the live-dot pulse and flicker).
  function tickDeviceStatuses() {
    for (const d of devices.values()) {
      const row = $('device-list').querySelector(`.device-row[data-key="${CSS.escape(d.key)}"]`);
      if (!row) continue;
      const st = deviceStatus(d);
      const dot = row.querySelector('.live-dot');
      if (dot) dot.className = 'live-dot ' + st.cls;
      const sub = row.querySelector('.device-sub');
      if (sub && sub.textContent !== st.text) sub.textContent = st.text;
    }
  }
  setInterval(tickDeviceStatuses, 1000);

  function renderServerDot() {
    const dot = $('server-dot');
    dot.classList.toggle('live', sseConnected);
    dot.classList.toggle('down', !sseConnected);
    dot.title = sseConnected ? 'Connected to local server' : 'Reconnecting to server…';
  }

  // ── Filters ──────────────────────────────────────────────────────────────
  function setFilter(key) {
    filterKey = key;
    renderFilters();
    renderDevices();
    render();
  }
  function renderFilters() {
    const bar = $('filters');
    const ds = [...devices.values()].sort((a, b) => (a.firstSeenMs ?? 0) - (b.firstSeenMs ?? 0));
    if (ds.length < 2) { bar.hidden = true; bar.innerHTML = ''; return; }
    bar.hidden = false;
    bar.innerHTML = '';
    bar.appendChild(chip(null, 'All devices', order.length, null));
    for (const d of ds) bar.appendChild(chip(d.key, deviceLabel(d), countFor(d.key), colorFor(d.key)));
  }
  function chip(key, label, n, color) {
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'chip' + (filterKey === key ? ' active' : '');
    if (color) {
      const dot = document.createElement('span');
      dot.className = 'chip-dot';
      dot.style.background = color;
      c.appendChild(dot);
    }
    const t = document.createElement('span');
    t.textContent = label;
    const cn = document.createElement('span');
    cn.className = 'chip-n';
    cn.textContent = n;
    c.append(t, cn);
    c.addEventListener('click', () => setFilter(key));
    return c;
  }

  // ── Feed ───────────────────────────────────────────────────────────────
  // Newest-first, filtered-by-device annotation list. Shared by the feed render
  // and the bulk-ticket modal so both operate on exactly what the user sees.
  function visibleAnnotations() {
    const shown = [];
    for (let i = order.length - 1; i >= 0; i--) {
      const id = order[i];
      const a = annotations.get(id);
      if (!a) continue;
      if (filterKey && a._deviceKey !== filterKey) continue;
      shown.push({ id, a, index: i });
    }
    return shown;
  }

  function render() {
    const feed = $('feed');
    $('count').textContent = String(order.length);
    $('clear-all').disabled = order.length === 0;

    const shown = visibleAnnotations();
    $('bulk-create').disabled = shown.length === 0;

    const emptyEl = $('empty');
    if (shown.length === 0) {
      emptyEl.hidden = false;
      emptyEl.innerHTML = filterKey
        ? 'No annotations from this device yet.'
        : '<span class="pulse-dot"></span>Waiting for the first annotation…';
    } else {
      emptyEl.hidden = true;
    }
    feed.innerHTML = '';
    const now = new Set();
    for (const { id, a, index } of shown) {
      // Animate only genuinely new cards, re-rendering on filter/update should
      // not replay the whole list's entrance.
      feed.appendChild(renderCard(a, index, !renderedIds.has(id)));
      now.add(id);
    }
    renderedIds = now;
  }

  function renderCard(a, index, animate) {
    const card = document.createElement('article');
    card.className = 'ann' + (animate ? ' enter' : '');
    card.dataset.id = a.id;

    const imgUrl = `${BASE}/annotations/${encodeURIComponent(a.id)}/image`;
    if (imagesPresent.has(a.id)) {
      // Image lives in its own wrapper so the copy/open actions can overlay it
      // (top-right) instead of cluttering the text-action row below.
      const wrap = document.createElement('div');
      wrap.className = 'ann-img-wrap';
      const img = document.createElement('img');
      img.className = 'ann-img';
      img.alt = '';
      img.loading = 'lazy';
      img.src = imgUrl;
      wrap.appendChild(img);
      const ov = document.createElement('div');
      ov.className = 'ann-img-actions';
      ov.appendChild(imgActionBtn('Copy image', ICON_COPY, (b) => copyImage(imgUrl, b)));
      ov.appendChild(imgActionBtn('Open image in new tab', ICON_OPEN, () => window.open(imgUrl, '_blank')));
      wrap.appendChild(ov);
      card.appendChild(wrap);
    } else {
      const ph = document.createElement('div');
      ph.className = 'ann-img placeholder';
      ph.textContent = a.screenshotPath ? 'Image uploading…' : 'No screenshot';
      card.appendChild(ph);
    }

    const body = document.createElement('div');
    body.className = 'ann-body';

    // Device tag, which device sent this annotation.
    const dev = devices.get(a._deviceKey) || a._device;
    if (a._deviceKey || dev) {
      const tag = document.createElement('div');
      tag.className = 'ann-device';
      const dot = document.createElement('span');
      dot.className = 'chip-dot';
      dot.style.background = colorFor(a._deviceKey ?? dev?.key ?? 'unknown');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = deviceLabel(dev);
      tag.append(dot, name);
      const pt = platformTag(dev);
      if (pt) { const p = document.createElement('span'); p.className = 'plat'; p.textContent = pt; tag.appendChild(p); }
      body.appendChild(tag);
    }

    const comment = document.createElement('p');
    comment.className = 'ann-comment';
    comment.textContent = a.comment ?? '';
    body.appendChild(comment);

    const badges = document.createElement('div');
    badges.className = 'badges';
    if (a.intent) badges.appendChild(badge('intent-' + a.intent, a.intent));
    if (a.severity) badges.appendChild(badge('severity-' + a.severity, a.severity));
    if (a.kind && a.kind !== 'feedback') badges.appendChild(badge('kind', a.kind));
    if (badges.children.length) body.appendChild(badges);

    const meta = document.createElement('div');
    meta.className = 'ann-meta';
    if (a.element) meta.appendChild(metaPart('Element', a.element));
    if (a.sourceFile) meta.appendChild(metaPart('Source', a.sourceFile));
    const time = fmtTime(a.createdAt ?? a.timestamp);
    if (time) meta.appendChild(metaPart('At', time));
    body.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'ann-actions';

    const copyMd = document.createElement('button');
    copyMd.textContent = 'Copy markdown';
    copyMd.addEventListener('click', () => copy(annotationMarkdown(a, index), copyMd));
    actions.appendChild(copyMd);

    const copyText = document.createElement('button');
    copyText.textContent = 'Copy comment';
    copyText.addEventListener('click', () => copy(a.comment ?? '', copyText));
    actions.appendChild(copyText);

    const del = document.createElement('button');
    del.className = 'btn-del';
    del.textContent = 'Delete';
    del.setAttribute('aria-label', 'Delete this annotation');
    del.addEventListener('click', () => deleteOne(a.id));
    actions.appendChild(del);

    body.appendChild(actions);

    // ClickUp ticket action — deliberately separated from the copy/delete row
    // above, branded, and showing exactly where the ticket lands (workspace).
    const ticketBar = document.createElement('div');
    ticketBar.className = 'ann-ticket';
    const ticket = document.createElement('button');
    ticket.className = 'cu-ticket-btn';
    ticket.innerHTML = cuLogo(14, '#fff') + '<span class="lbl">Create ClickUp ticket</span>';
    if (clickup.connected && clickup.teamName) {
      const dest = document.createElement('span');
      dest.className = 'dest';
      dest.textContent = '→ ' + clickup.teamName;
      ticket.appendChild(dest);
    }
    ticket.addEventListener('click', () => openTicketModal(a, index));
    ticketBar.appendChild(ticket);
    body.appendChild(ticketBar);

    card.appendChild(body);
    return card;
  }

  function badge(cls, text) {
    const b = document.createElement('span');
    b.className = 'badge ' + cls;
    b.textContent = text;
    return b;
  }
  function metaPart(label, value) {
    const span = document.createElement('span');
    span.innerHTML = `<b>${escapeHtml(label)}:</b> ${escapeHtml(value)}`;
    return span;
  }

  async function deleteOne(id) {
    try {
      const res = await fetch(`${BASE}/annotations/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('http ' + res.status);
      // Server broadcasts a 'delete' SSE event that updates local state.
    } catch {
      toast('Delete failed');
    }
  }

  // ── Confirmation modal ───────────────────────────────────────────────────
  let confirmResolver = null;
  function showConfirm({ title = 'Are you sure?', body = '', confirmText = 'Confirm', danger = false } = {}) {
    return new Promise((resolve) => {
      if (confirmResolver) { confirmResolver(false); confirmResolver = null; }
      confirmResolver = resolve;
      $('confirm-title').textContent = title;
      $('confirm-body').textContent = body;
      const ok = $('confirm-ok');
      ok.textContent = confirmText;
      ok.classList.toggle('btn-danger', !!danger);
      ok.classList.toggle('btn-ghost', !danger);
      $('confirm-modal').hidden = false;
      setTimeout(() => $(danger ? 'confirm-cancel' : 'confirm-ok').focus(), 0);
    });
  }
  function closeConfirm(result) {
    if (confirmResolver) { confirmResolver(result); confirmResolver = null; }
    $('confirm-modal').hidden = true;
  }
  $('confirm-ok').addEventListener('click', () => closeConfirm(true));
  $('confirm-cancel').addEventListener('click', () => closeConfirm(false));
  $('confirm-modal').addEventListener('click', (e) => { if (e.target === $('confirm-modal')) closeConfirm(false); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('connect-modal').hidden) { closeConnectModal(); return; }
    if (e.key === 'Escape' && !$('ticket-modal').hidden) { closeTicketModal(); return; }
    if (e.key === 'Escape' && !$('bulk-modal').hidden) { closeBulkModal(); return; }
    if (e.key === 'Escape' && !$('integrations-modal').hidden) { closeIntegrations(); return; }
    if (e.key === 'Escape' && !$('troubleshoot-modal').hidden) { closeTroubleshoot(); return; }
    if ($('confirm-modal').hidden) return;
    if (e.key === 'Escape') closeConfirm(false);
    else if (e.key === 'Enter') {
      if (document.activeElement === $('confirm-ok')) closeConfirm(true);
      else if (document.activeElement === $('confirm-cancel')) closeConfirm(false);
    }
  });

  // Start a fresh session. The server rotates its current token and drops the
  // old room; we reload so GET / hands us the new token (and an empty feed).
  // Connected devices keep posting to the OLD url until they re-scan the new one.
  $('new-session-btn').addEventListener('click', async () => {
    const ok = await showConfirm({
      title: 'Start a new session?',
      body: 'This starts a fresh capture with an empty feed. The current annotations are cleared, and connected devices will need to scan or paste the new session URL to reconnect.',
      confirmText: 'New session',
      danger: false,
    });
    if (!ok) return;
    try {
      const r = await fetch('/session/new', { method: 'POST' });
      if (!r.ok) throw new Error('http ' + r.status);
      location.reload();
    } catch { toast('Could not start a new session'); }
  });

  $('clear-all').addEventListener('click', async () => {
    if ($('clear-all').disabled) return;
    const ok = await showConfirm({
      title: 'Delete all annotations?',
      body: 'Are you sure you want to delete all annotations? This action is not reversible.',
      confirmText: 'Delete all',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(`${BASE}/annotations`, { method: 'DELETE' });
      if (!res.ok) throw new Error('http ' + res.status);
    } catch {
      toast('Delete failed');
    }
  });

  // ── SSE ──────────────────────────────────────────────────────────────────
  let es;
  function connect() {
    es = new EventSource(`${BASE}/events`);

    es.addEventListener('hello', (ev) => {
      sseConnected = true;
      const data = JSON.parse(ev.data);
      for (const d of data.devices ?? []) upsertDevice(d, data.serverNow);
      renderServerDot();
      renderDevices();
      renderFilters();
    });

    es.addEventListener('device', (ev) => {
      const data = JSON.parse(ev.data);
      upsertDevice(data.device, data.serverNow);
      renderDevices(); // flips the hero → feed once the first device pairs
      renderFilters();
    });

    es.addEventListener('annotation', (ev) => {
      const a = JSON.parse(ev.data);
      const wasNew = !annotations.has(a.id);
      annotations.set(a.id, a);
      if (wasNew) order.push(a.id);
      // An annotation may reference a device we haven't rendered yet.
      if (a._device?.key && !devices.has(a._device.key)) { upsertDevice(a._device, null); renderDevices(); }
      renderFilters();
      renderDevices(); // refresh per-device tallies
      render();
    });

    es.addEventListener('image', (ev) => {
      const { id } = JSON.parse(ev.data);
      imagesPresent.add(id);
      const old = document.querySelector(`.ann[data-id="${CSS.escape(id)}"]`);
      const a = annotations.get(id);
      if (old && a) {
        old.replaceWith(renderCard(a, order.indexOf(id), false));
      } else {
        render();
      }
    });

    es.addEventListener('delete', (ev) => {
      const { id } = JSON.parse(ev.data);
      annotations.delete(id);
      imagesPresent.delete(id);
      const i = order.indexOf(id);
      if (i >= 0) order.splice(i, 1);
      renderFilters();
      renderDevices();
      render();
    });

    // Phone-side diagnostic report, relayed from public/diag.html. Only the
    // open troubleshooter cares; it registers onDiagReport while waiting.
    es.addEventListener('diag', (ev) => {
      try { if (onDiagReport) onDiagReport(JSON.parse(ev.data)); } catch {}
    });

    es.addEventListener('clear', () => {
      annotations.clear();
      imagesPresent.clear();
      order.length = 0;
      renderFilters();
      renderDevices();
      render();
    });

    es.onerror = () => {
      sseConnected = false;
      renderServerDot();
      renderDevices();
      // EventSource auto-reconnects.
    };
  }

  renderServerDot();
  renderDevices();
  render();
  connect();
  refreshClickup();
})();
