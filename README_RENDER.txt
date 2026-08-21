Render setup

Build Command: npm install
Start Command: node treechoper_two_native_auth_staggered_fixed.js
Health Check Path: /healthz

The code listens on 0.0.0.0:$PORT for Render web-service health checks.

Account defaults are inside the JS file and can also be overridden with:
BOT1_USERNAME, BOT1_PASSWORD, BOT2_USERNAME, BOT2_PASSWORD

Local validation:
TREEBOT_SELFTEST=1 node treechoper_two_native_auth_staggered_fixed.js

Important: Render Free web services are not guaranteed 24/7; they can spin down after 15 minutes without inbound traffic and can restart.
