import { relations } from "drizzle-orm/relations";
import { encryptedFiles, accessLogs, users, fileMetadata, shareLinks, folders } from "./schema";

export const accessLogsRelations = relations(accessLogs, ({one}) => ({
	encryptedFile: one(encryptedFiles, {
		fields: [accessLogs.fileId],
		references: [encryptedFiles.id]
	}),
	user: one(users, {
		fields: [accessLogs.actorId],
		references: [users.id]
	}),
}));

export const encryptedFilesRelations = relations(encryptedFiles, ({one, many}) => ({
	accessLogs: many(accessLogs),
	user: one(users, {
		fields: [encryptedFiles.ownerId],
		references: [users.id]
	}),
	fileMetadata: many(fileMetadata),
	shareLinks: many(shareLinks),
}));

export const usersRelations = relations(users, ({many}) => ({
	accessLogs: many(accessLogs),
	encryptedFiles: many(encryptedFiles),
	folders: many(folders),
}));

export const fileMetadataRelations = relations(fileMetadata, ({one}) => ({
	encryptedFile: one(encryptedFiles, {
		fields: [fileMetadata.fileId],
		references: [encryptedFiles.id]
	}),
}));

export const shareLinksRelations = relations(shareLinks, ({one}) => ({
	encryptedFile: one(encryptedFiles, {
		fields: [shareLinks.fileId],
		references: [encryptedFiles.id]
	}),
}));

export const foldersRelations = relations(folders, ({one}) => ({
	user: one(users, {
		fields: [folders.ownerId],
		references: [users.id]
	}),
}));