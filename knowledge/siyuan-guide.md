# SiYuan Structured Memory

## What is it?
SiYuan is a local-first knowledge management system that gives your bot queryable, linked, visual memory. Instead of searching flat text, your bot can query structured databases (contacts, invoices, products) and see how information connects.

## What it adds
- **Database blocks** — Structured data with columns, filters, and sorting (contacts, invoices, inventory)
- **Backlinks** — See how information connects (person → projects → tasks)
- **Graph view** — Visual knowledge map of all your bot's memories
- **Full-text search** — Fast search across all structured content
- **SQL queries** — Query your bot's knowledge with SQL

## Setup (one command)
```bash
./setup-siyuan.sh
```
This pulls the Docker image, generates an auth token, and configures your bot automatically.

## Requirements
- Docker installed on your server
- ~500MB disk space for the image
- Port 6806 available

## How it works with Favor
- SiYuan runs alongside SQLite (your existing memory is untouched)
- The bot checks SiYuan first for structured queries, falls back to SQLite for general memory
- If SiYuan is offline, everything works normally — just without structured queries
- Access the web UI at `http://your-server:6806` to create databases and organize knowledge

## Creating databases
Open the SiYuan web UI and create database blocks for:
1. **Contacts** — Name, birthday, role, company, notes
2. **Invoices** — Date, recipient, amount, items, status
3. **Products** — Name, category, SKU, inventory, batch code
4. **Goals** — Title, priority, progress, status

Your bot can then query these directly when users ask questions like "when is Sarah's birthday?" or "how much did we invoice last month?"
