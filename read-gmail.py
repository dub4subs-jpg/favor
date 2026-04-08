#!/usr/bin/env python3
"""Read/search Gmail via OAuth2 API. Used by Favor bot for email tools."""
import json, sys, os, urllib.request, urllib.parse, urllib.error, base64, re
from html.parser import HTMLParser

# Paths relative to Favor's data directory
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OAUTH_CREDS = os.path.join(SCRIPT_DIR, 'data', 'gmail-oauth-credentials.json')
TOKENS_FILE = os.path.join(SCRIPT_DIR, 'data', 'gmail-oauth-tokens.json')

def refresh_access_token():
    if not os.path.exists(OAUTH_CREDS):
        print(f'ERROR: Gmail OAuth credentials not found at {OAUTH_CREDS}')
        print('To set up Gmail:')
        print('  1. Go to https://console.cloud.google.com/apis/credentials')
        print('  2. Create an OAuth 2.0 Client ID (Desktop app)')
        print('  3. Download the JSON and save it as data/gmail-oauth-credentials.json')
        print('  4. Run: python3 read-gmail.py setup')
        sys.exit(1)
    if not os.path.exists(TOKENS_FILE):
        print(f'ERROR: Gmail tokens not found at {TOKENS_FILE}')
        print('Run: python3 read-gmail.py setup')
        sys.exit(1)
    creds = json.load(open(OAUTH_CREDS))
    # Handle both formats: {"installed": {...}} and {"web": {...}}
    creds = creds.get('installed', creds.get('web', creds))
    tokens = json.load(open(TOKENS_FILE))
    data = urllib.parse.urlencode({
        'client_id': creds['client_id'],
        'client_secret': creds['client_secret'],
        'refresh_token': tokens['refresh_token'],
        'grant_type': 'refresh_token'
    }).encode()
    req = urllib.request.Request('https://oauth2.googleapis.com/token', data=data)
    resp = json.loads(urllib.request.urlopen(req).read())
    tokens['access_token'] = resp['access_token']
    json.dump(tokens, open(TOKENS_FILE, 'w'), indent=2)
    return resp['access_token']

def gmail_api(endpoint, token):
    url = f'https://gmail.googleapis.com/gmail/v1/users/me/{endpoint}'
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'})
    return json.loads(urllib.request.urlopen(req).read())

class HTMLStripper(HTMLParser):
    def __init__(self):
        super().__init__()
        self.text = []
    def handle_data(self, data):
        self.text.append(data)
    def get_text(self):
        return ' '.join(self.text).strip()

def strip_html(html):
    s = HTMLStripper()
    s.feed(html)
    return s.get_text()

def get_header(headers, name):
    for h in headers:
        if h['name'].lower() == name.lower():
            return h['value']
    return ''

def decode_body(part):
    """Extract text from a message part."""
    if 'body' in part and 'data' in part['body']:
        data = part['body']['data']
        text = base64.urlsafe_b64decode(data + '==').decode('utf-8', errors='replace')
        if part.get('mimeType') == 'text/html':
            return strip_html(text)
        return text
    return ''

def extract_text(payload):
    """Recursively extract text from message payload."""
    texts = []
    if 'parts' in payload:
        for part in payload['parts']:
            mime = part.get('mimeType', '')
            if mime == 'text/plain':
                texts.append(decode_body(part))
            elif mime == 'text/html' and not texts:
                texts.append(decode_body(part))
            elif mime.startswith('multipart/'):
                texts.append(extract_text(part))
    else:
        texts.append(decode_body(payload))
    return '\n'.join(t for t in texts if t)

def search_emails(query, max_results=5):
    """Search Gmail and return message summaries."""
    token = refresh_access_token()
    encoded_q = urllib.parse.quote(query)
    result = gmail_api(f'messages?q={encoded_q}&maxResults={max_results}', token)

    messages = result.get('messages', [])
    if not messages:
        return json.dumps({"count": 0, "results": [], "query": query})

    results = []
    for msg_ref in messages:
        msg = gmail_api(f'messages/{msg_ref["id"]}?format=full', token)
        headers = msg.get('payload', {}).get('headers', [])
        body_text = extract_text(msg.get('payload', {}))
        if len(body_text) > 500:
            body_text = body_text[:500] + '...'

        results.append({
            "id": msg['id'],
            "from": get_header(headers, 'From'),
            "to": get_header(headers, 'To'),
            "subject": get_header(headers, 'Subject'),
            "date": get_header(headers, 'Date'),
            "snippet": msg.get('snippet', ''),
            "body": body_text,
            "labels": msg.get('labelIds', [])
        })

    return json.dumps({"count": len(results), "total": result.get('resultSizeEstimate', 0), "query": query, "results": results}, indent=2)

def read_email(msg_id):
    """Read a specific email by ID."""
    token = refresh_access_token()
    msg = gmail_api(f'messages/{msg_id}?format=full', token)
    headers = msg.get('payload', {}).get('headers', [])
    body_text = extract_text(msg.get('payload', {}))

    return json.dumps({
        "id": msg['id'],
        "from": get_header(headers, 'From'),
        "to": get_header(headers, 'To'),
        "subject": get_header(headers, 'Subject'),
        "date": get_header(headers, 'Date'),
        "body": body_text,
        "labels": msg.get('labelIds', [])
    }, indent=2)

def setup_oauth():
    """Interactive OAuth setup — run once to authorize Gmail access."""
    if not os.path.exists(OAUTH_CREDS):
        print(f'First, save your OAuth credentials JSON to: {OAUTH_CREDS}')
        print('Get it from: https://console.cloud.google.com/apis/credentials')
        print('Create an OAuth 2.0 Client ID → Desktop app → Download JSON')
        sys.exit(1)
    creds = json.load(open(OAUTH_CREDS))
    creds = creds.get('installed', creds.get('web', creds))
    auth_url = (
        f"https://accounts.google.com/o/oauth2/v2/auth?"
        f"client_id={creds['client_id']}&"
        f"redirect_uri=urn:ietf:wg:oauth:2.0:oob&"
        f"response_type=code&"
        f"scope=https://www.googleapis.com/auth/gmail.modify&"
        f"access_type=offline&prompt=consent"
    )
    print(f'\nOpen this URL in your browser:\n\n{auth_url}\n')
    code = input('Paste the authorization code here: ').strip()
    data = urllib.parse.urlencode({
        'client_id': creds['client_id'],
        'client_secret': creds['client_secret'],
        'code': code,
        'grant_type': 'authorization_code',
        'redirect_uri': 'urn:ietf:wg:oauth:2.0:oob'
    }).encode()
    req = urllib.request.Request('https://oauth2.googleapis.com/token', data=data)
    resp = json.loads(urllib.request.urlopen(req).read())
    json.dump(resp, open(TOKENS_FILE, 'w'), indent=2)
    print(f'\nTokens saved to {TOKENS_FILE}')
    print('Gmail is ready to use!')

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage:')
        print('  python3 read-gmail.py setup              — First-time OAuth setup')
        print('  python3 read-gmail.py search "query" [max]')
        print('  python3 read-gmail.py read <message_id>')
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == 'setup':
        setup_oauth()
    elif cmd == 'search':
        if len(sys.argv) < 3:
            print('Usage: python3 read-gmail.py search "query" [max_results]')
            sys.exit(1)
        query = sys.argv[2]
        max_r = int(sys.argv[3]) if len(sys.argv) > 3 else 5
        print(search_emails(query, max_r))
    elif cmd == 'read':
        if len(sys.argv) < 3:
            print('Usage: python3 read-gmail.py read <message_id>')
            sys.exit(1)
        print(read_email(sys.argv[2]))
    else:
        print(f'Unknown command: {cmd}')
        sys.exit(1)
