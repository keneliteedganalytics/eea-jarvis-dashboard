"""LOCKED PRINT WORKFLOW (per Ken, 2026-06-12).

ALWAYS use this to generate the print PDF. Do NOT use any custom ReportLab
generator — the only correct print format is the one Jarvis's /print page
renders, captured with a headless browser.

Usage:
  python3 print_card_from_jarvis.py [CARD_ID] [OUT_PATH]

If CARD_ID is omitted, prints the latest card.
"""
import subprocess, sys, os, json, base64, urllib.request
from pathlib import Path

def render(card_id=None, out_path=None):
    api = 'https://jarvis.elite-edge-analytics.com'
    auth = base64.b64encode(b'EliteEdgeAnalytics:Austin08').decode()

    # If card_id not given, resolve "latest"
    if card_id is None:
        req = urllib.request.Request(api + '/api/cards/latest',
                                     headers={'Authorization': f'Basic {auth}'})
        latest = json.loads(urllib.request.urlopen(req, timeout=10).read())
        card_id = latest['id']

    if out_path is None:
        # derive from card meta
        req = urllib.request.Request(api + f'/api/cards/{card_id}',
                                     headers={'Authorization': f'Basic {auth}'})
        meta = json.loads(urllib.request.urlopen(req, timeout=10).read())
        track_slug = meta['track'].lower().replace(' ', '_').replace('(', '').replace(')', '')
        out_dir = Path(f"/home/user/workspace/cards_{meta['date']}/{track_slug.split('_')[0]}/pdfs")
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = str(out_dir / f"{track_slug.split('_')[0]}_{meta['date']}.pdf")

    # Drive Playwright via Node so this works from cron / shell
    node_script = f'''
const playwright = require('playwright');
const fs = require('fs');
(async () => {{
  const browser = await playwright.chromium.launch();
  const ctx = await browser.newContext({{
    httpCredentials: {{ username: 'EliteEdgeAnalytics', password: 'Austin08' }}
  }});
  const page = await ctx.newPage();
  await page.goto('{api}/#/print', {{ waitUntil: 'domcontentloaded', timeout: 60000 }});
  await page.waitForSelector('text=Elite Edge Analytics', {{ timeout: 30000 }});
  // Ensure at least one race row rendered
  await page.waitForSelector('text=Race 1', {{ timeout: 30000 }});
  await page.waitForTimeout(2000);
  await page.emulateMedia({{ media: 'print' }});
  await page.pdf({{
    path: '{out_path}',
    format: 'Letter',
    printBackground: true,
    margin: {{ top: '0.4in', bottom: '0.4in', left: '0.4in', right: '0.4in' }}
  }});
  await browser.close();
  console.log('OK', '{out_path}', fs.statSync('{out_path}').size);
}})().catch(e => {{ console.error(e); process.exit(1); }});
'''
    script_path = '/tmp/jarvis_print_render.js'
    Path(script_path).write_text(node_script)
    result = subprocess.run(['node', script_path], capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise RuntimeError(f"Playwright failed:\nSTDOUT: {result.stdout}\nSTDERR: {result.stderr}")
    print(result.stdout.strip())
    return out_path

if __name__ == '__main__':
    card_id = int(sys.argv[1]) if len(sys.argv) > 1 else None
    out_path = sys.argv[2] if len(sys.argv) > 2 else None
    render(card_id, out_path)
