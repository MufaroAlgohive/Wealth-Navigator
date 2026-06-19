import os, glob

# 1. Update public HTML files to point to ?action=me
for file in glob.glob('public/*.html'):
    with open(file, 'r', encoding='utf-8') as f:
        content = f.read()
    
    if '/api/team/me' in content:
        content = content.replace('/api/team/me', '/api/team?action=me')
        with open(file, 'w', encoding='utf-8') as f:
            f.write(content)

# 2. Update team.html for all endpoints
with open('public/team.html', 'r', encoding='utf-8') as f:
    team = f.read()

team = team.replace('/api/team/list', '/api/team?action=list')
team = team.replace('/api/team/remove', '/api/team?action=remove')
team = team.replace('/api/team/invite', '/api/team?action=invite')
team = team.replace('/api/team/update', '/api/team?action=update')
with open('public/team.html', 'w', encoding='utf-8') as f:
    f.write(team)

# 3. Update server.js
with open('server.js', 'r', encoding='utf-8') as f:
    server = f.read()

server = server.replace("const teamMeHandler = require('./api/team/me');\n", "")
server = server.replace("const teamListHandler = require('./api/team/list');\n", "")
server = server.replace("const teamInviteHandler = require('./api/team/invite');\n", "")
server = server.replace("const teamUpdateHandler = require('./api/team/update');\n", "")
server = server.replace("const teamRemoveHandler = require('./api/team/remove');\n", "const teamHandler = require('./api/team');\n")

# Replacements in the server block
server = server.replace("""  if (req.url.startsWith('/api/team/me') && req.method === 'GET') {
    (async () => { teamMeHandler(req, res); })(); return;
  }
  if (req.url.startsWith('/api/team/list') && req.method === 'GET') {
    (async () => { teamListHandler(req, res); })(); return;
  }
  if (req.url.startsWith('/api/team/invite') && req.method === 'POST') {
    (async () => { req.body = await readJsonBody(req); teamInviteHandler(req, res); })(); return;
  }
  if (req.url.startsWith('/api/team/update') && (req.method === 'PUT' || req.method === 'POST')) {
    (async () => { req.body = await readJsonBody(req); teamUpdateHandler(req, res); })(); return;
  }
  if (req.url.startsWith('/api/team/remove') && req.method === 'DELETE') {
    (async () => { req.body = await readJsonBody(req).catch(() => ({})); teamRemoveHandler(req, res); })(); return;
  }""", """  if (req.url.startsWith('/api/team') && !req.url.includes('/api/team/')) {
    // Single consolidated block for Vercel Hobby serverless limits
    (async () => {
      if (req.method !== 'GET') {
        req.body = await readJsonBody(req).catch(() => ({}));
      }
      teamHandler(req, res);
    })();
    return;
  }""")
with open('server.js', 'w', encoding='utf-8') as f:
    f.write(server)
