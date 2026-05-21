/**
 * SQLite database initialization and management
 */
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { getDefaultConfig } from '../utils/platform.js';
import { ensureDir } from '../utils/fs.js';
import { dirname } from 'node:path';

let _db: Database.Database | null = null;

/** Get or create the database connection */
export async function getDb(): Promise<Database.Database> {
  if (_db) return _db;

  const config = getDefaultConfig();
  await ensureDir(dirname(config.dbPath));

  _db = new Database(config.dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  initSchema(_db);
  return _db;
}

/** Initialize database tables */
function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_url TEXT NOT NULL,
      source_commit TEXT NOT NULL,
      version TEXT DEFAULT '0.0.0',
      description TEXT DEFAULT '',
      scope TEXT NOT NULL DEFAULT 'global',
      project_path TEXT DEFAULT '',
      alias TEXT,
      installed_path TEXT NOT NULL,
      unified_path TEXT,
      symlink_target TEXT,
      integrity TEXT DEFAULT '',
      install_mode TEXT NOT NULL DEFAULT 'copy',
      is_linked INTEGER DEFAULT 0,
      installed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      assigned_agents TEXT DEFAULT 'all'
    );

    CREATE TABLE IF NOT EXISTS dependencies (
      id TEXT PRIMARY KEY,
      parent_skill_id TEXT NOT NULL,
      child_skill_name TEXT NOT NULL,
      child_source TEXT,
      required_version TEXT,
      FOREIGN KEY (parent_skill_id) REFERENCES skills(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS mcp_configs (
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'stdio',
      command TEXT NOT NULL,
      args TEXT DEFAULT '[]',
      env TEXT DEFAULT '{}',
      agent_configs TEXT DEFAULT '{}',
      FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS mcp_installations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'stdio',
      command TEXT NOT NULL,
      args TEXT DEFAULT '[]',
      env TEXT DEFAULT '{}',
      scope TEXT NOT NULL DEFAULT 'global',
      project_path TEXT DEFAULT '',
      assigned_agents TEXT DEFAULT 'all',
      installed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS replace_history (
      id TEXT PRIMARY KEY,
      skill_name TEXT NOT NULL,
      old_source TEXT NOT NULL,
      old_commit TEXT NOT NULL,
      new_source TEXT NOT NULL,
      new_commit TEXT NOT NULL,
      replaced_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      detected INTEGER DEFAULT 0,
      skills_dir TEXT,
      last_sync TEXT
    );

    CREATE TABLE IF NOT EXISTS project_skills (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      skill_source TEXT NOT NULL,
      version TEXT,
      installed_skill_id TEXT,
      FOREIGN KEY (installed_skill_id) REFERENCES skills(id) ON DELETE SET NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_skill
      ON project_skills(project_path, skill_source);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_installation_scope
      ON mcp_installations(name, scope, project_path);
  `);

  // Migration: add assigned_agents to skills if not exists
  const tableInfo = db.pragma('table_info(skills)') as any[];
  if (!tableInfo.some((col: any) => col.name === 'assigned_agents')) {
    db.exec(`ALTER TABLE skills ADD COLUMN assigned_agents TEXT DEFAULT 'all'`);
  }
  if (!tableInfo.some((col: any) => col.name === 'project_path')) {
    db.exec(`ALTER TABLE skills ADD COLUMN project_path TEXT DEFAULT ''`);
  }
  if (!tableInfo.some((col: any) => col.name === 'symlink_target')) {
    db.exec(`ALTER TABLE skills ADD COLUMN symlink_target TEXT`);
  }
  if (!tableInfo.some((col: any) => col.name === 'unified_path')) {
    db.exec(`ALTER TABLE skills ADD COLUMN unified_path TEXT`);
  }
  if (!tableInfo.some((col: any) => col.name === 'integrity')) {
    db.exec(`ALTER TABLE skills ADD COLUMN integrity TEXT DEFAULT ''`);
  }
  if (!tableInfo.some((col: any) => col.name === 'install_mode')) {
    db.exec(`ALTER TABLE skills ADD COLUMN install_mode TEXT NOT NULL DEFAULT 'copy'`);
    db.exec(`
      UPDATE skills
      SET install_mode = CASE
        WHEN is_linked = 1 AND source_url LIKE 'file://%' THEN 'symlink-dev'
        WHEN is_linked = 1 THEN 'symlink-cache'
        ELSE 'copy'
      END
    `);
  }

  db.exec(`
    DROP INDEX IF EXISTS idx_skills_name_scope;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_name_scope_project
      ON skills(name, scope, project_path);
  `);
}

/** Close the database connection */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/** Generate a unique ID */
export function genId(): string {
  return randomUUID();
}
