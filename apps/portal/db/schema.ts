import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
} from 'drizzle-orm/sqlite-core';
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  name: text('name').notNull(),
});
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ownerId: text('owner_id').notNull(),
  createdAt: integer('created_at').notNull(),
});
export const members = sqliteTable(
  'members',
  {
    projectId: text('project_id').notNull(),
    userId: text('user_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    index('members_user').on(t.userId),
  ],
);
export const invitations = sqliteTable(
  'invitations',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    email: text('email').notNull(),
    senderId: text('sender_id').notNull(),
    expiresAt: integer('expires_at').notNull(),
    acceptedBy: text('accepted_by'),
  },
  (t) => [index('invitations_email').on(t.email)],
);
export const devices = sqliteTable(
  'devices',
  {
    id: text('id').primaryKey(),
    tokenHash: text('token_hash').notNull().unique(),
    userCode: text('user_code').notNull().unique(),
    name: text('name').notNull(),
    encryptionKey: text('encryption_key').notNull(),
    userId: text('user_id'),
    expiresAt: integer('expires_at').notNull(),
    pairExpiresAt: integer('pair_expires_at').notNull(),
    lastSeen: integer('last_seen').notNull(),
    projectId: text('project_id'),
    revoked: integer('revoked').notNull().default(0),
  },
  (t) => [index('devices_user').on(t.userId)],
);
export const transfers = sqliteTable(
  'transfers',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    senderDeviceId: text('sender_device_id').notNull(),
    recipientDeviceId: text('recipient_device_id').notNull(),
    envelope: text('envelope').notNull(),
    expiresAt: integer('expires_at').notNull(),
    blobReady: integer('blob_ready').notNull().default(0),
    acked: integer('acked').notNull().default(0),
  },
  (t) => [index('transfers_recipient').on(t.recipientDeviceId, t.expiresAt)],
);
export const limits = sqliteTable('limits', {
  key: text('key').primaryKey(),
  count: integer('count').notNull(),
  expiresAt: integer('expires_at').notNull(),
});
export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    title: text('title').notNull(),
    status: text('status').notNull().default('open'),
    ownerDeviceId: text('owner_device_id'),
    leaseUntil: integer('lease_until').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('tasks_project').on(t.projectId)],
);
export const intents = sqliteTable(
  'intents',
  {
    deviceId: text('device_id').notNull(),
    projectId: text('project_id').notNull(),
    paths: text('paths').notNull(),
    summary: text('summary').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.deviceId, t.projectId] })],
);
export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    senderDeviceId: text('sender_device_id').notNull(),
    text: text('text').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('messages_project').on(t.projectId, t.createdAt)],
);
