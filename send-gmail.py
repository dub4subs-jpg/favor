#!/usr/bin/env python3
"""Send email via Gmail OAuth2 API (HTTPS, no SMTP needed). Used by Favor bot."""
import json, sys, os, base64, urllib.request, urllib.parse, urllib.error
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.application import MIMEApplication

# Paths relative to Favor's data directory
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OAUTH_CREDS = os.path.join(SCRIPT_DIR, 'data', 'gmail-oauth-credentials.json')
TOKENS_FILE = os.path.join(SCRIPT_DIR, 'data', 'gmail-oauth-tokens.json')

def refresh_access_token():
    if not os.path.exists(OAUTH_CREDS):
        print('ERROR: Gmail not configured. Run: python3 read-gmail.py setup')
        sys.exit(1)
    if not os.path.exists(TOKENS_FILE):
        print('ERROR: Gmail tokens not found. Run: python3 read-gmail.py setup')
        sys.exit(1)
    creds = json.load(open(OAUTH_CREDS))
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

def get_sender_email():
    """Get the authenticated user's email address."""
    token = refresh_access_token()
    req = urllib.request.Request(
        'https://gmail.googleapis.com/gmail/v1/users/me/profile',
        headers={'Authorization': f'Bearer {token}'}
    )
    resp = json.loads(urllib.request.urlopen(req).read())
    return resp['emailAddress']

def send_email(to, subject, body, attachment_path=None):
    token = refresh_access_token()
    sender = get_sender_email()

    msg = MIMEMultipart()
    msg['From'] = sender
    msg['To'] = to
    msg['Subject'] = subject
    msg.attach(MIMEText(body, 'plain'))

    if attachment_path:
        with open(attachment_path, 'rb') as f:
            filename = os.path.basename(attachment_path)
            att = MIMEApplication(f.read())
            att.add_header('Content-Disposition', 'attachment', filename=filename)
            msg.attach(att)

    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode('utf-8')
    payload = json.dumps({'raw': raw}).encode()

    req = urllib.request.Request(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
        data=payload,
        headers={
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json'
        }
    )
    try:
        resp = urllib.request.urlopen(req)
        result = json.loads(resp.read())
        print(f"SENT OK — Message ID: {result['id']}")
    except urllib.error.HTTPError as e:
        print(f"FAILED: {e.code} {e.read().decode()}")
        sys.exit(1)

if __name__ == '__main__':
    if len(sys.argv) < 4:
        print('Usage: python3 send-gmail.py <to> <subject> <body> [attachment_path]')
        print('')
        print('Gmail must be configured first: python3 read-gmail.py setup')
        sys.exit(1)
    att = sys.argv[4] if len(sys.argv) > 4 else None
    send_email(sys.argv[1], sys.argv[2], sys.argv[3], att)
