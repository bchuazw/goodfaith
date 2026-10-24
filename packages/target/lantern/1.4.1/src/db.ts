// Lantern data model and in-memory store.
//
// Lantern is a small self-hosted notes app. A user keeps private notes, can share some, and can
// attach files to them. One account is an administrator who can see the full user directory.

export type Role = "user" | "admin";
export type Visibility = "private" | "shared";

export interface User {
  id: string;
  email: string;
  displayName: string;
  bio: string;
  role: Role;
  /** Account recovery code. Only ever exposed to the account owner and administrators. */
  backupCode: string;
  createdAt: string;
}

export interface Note {
  id: string;
  ownerId: string;
  title: string;
  body: string;
  visibility: Visibility;
  updatedAt: string;
}

export interface Attachment {
  id: string;
  noteId: string;
  ownerId: string;
  filename: string;
  storedPath: string;
  contentType: string;
  size: number;
}

export interface Seed {
  users: User[];
  notes: Note[];
  attachments: Attachment[];
}

/** The public shape of a user: never includes the recovery code. */
export function publicUser(user: User): Omit<User, "backupCode"> {
  const { backupCode: _omit, ...rest } = user;
  return rest;
}

export class Database {
  private readonly users = new Map<string, User>();
  private readonly notes = new Map<string, Note>();
  private readonly attachments = new Map<string, Attachment>();

  constructor(seed: Seed) {
    for (const user of seed.users) this.users.set(user.id, user);
    for (const note of seed.notes) this.notes.set(note.id, note);
    for (const attachment of seed.attachments) this.attachments.set(attachment.id, attachment);
  }

  getUser(id: string): User | undefined {
    return this.users.get(id);
  }

  findUserByEmail(email: string): User | undefined {
    const wanted = email.trim().toLowerCase();
    for (const user of this.users.values()) if (user.email.toLowerCase() === wanted) return user;
    return undefined;
  }

  listUsers(): User[] {
    return [...this.users.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  getNote(id: string): Note | undefined {
    return this.notes.get(id);
  }

  listNotesByOwner(ownerId: string): Note[] {
    return [...this.notes.values()].filter((n) => n.ownerId === ownerId).sort((a, b) => a.id.localeCompare(b.id));
  }

  createNote(note: Note): Note {
    this.notes.set(note.id, note);
    return note;
  }

  getAttachment(id: string): Attachment | undefined {
    return this.attachments.get(id);
  }

  listAttachments(noteId: string): Attachment[] {
    return [...this.attachments.values()].filter((a) => a.noteId === noteId);
  }

  addAttachment(attachment: Attachment): Attachment {
    this.attachments.set(attachment.id, attachment);
    return attachment;
  }

  nextId(prefix: string): string {
    let n = 1;
    while (this.notes.has(`${prefix}${n}`) || this.attachments.has(`${prefix}${n}`)) n++;
    return `${prefix}${n}`;
  }
}
