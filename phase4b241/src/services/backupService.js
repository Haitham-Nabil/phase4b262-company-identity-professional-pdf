import { customerRepository } from '../repositories/customerRepository.js';
import { transactionRepository } from '../repositories/transactionRepository.js';
import { openingBalanceRepository } from '../repositories/openingBalanceRepository.js';
import { settingsRepository } from '../repositories/settingsRepository.js';
import { metadataRepository } from '../repositories/metadataRepository.js';
import { auditLogRepository } from '../repositories/auditLogRepository.js';
import { receivingCompanyRepository } from '../repositories/receivingCompanyRepository.js';
import { cartonTypeRepository } from '../repositories/cartonTypeRepository.js';
import { strawberryVarietyRepository } from '../repositories/strawberryVarietyRepository.js';
import { DB_VERSION } from '../storage/schema.js';
import { METADATA_KEYS } from '../storage/defaults.js';
import { nowIso } from '../domain/dateUtils.js';

export const BACKUP_APP_ID = 'CustomerAccountsDB';
// Phase 4B.11 — the FORMAT version is unchanged on purpose: the two new sections are
// additive OPTIONAL sections, so a file written here still opens in the earlier reader
// rules and an earlier file still restores here. Only the new sections are added.
export const BACKUP_FORMAT_VERSION = 1;

// Single structured JSON backup (spec §32). No cloud, no server.
export const backupService = {
  async createBackup() {
    const { authService } = await import('./authService.js'); authService.assertCanManageData();
    const [customers, transactions, openingBalanceHistory, settings, metadata, auditLog, receivingCompanies, cartonTypes, strawberryVarieties] = await Promise.all([
      customerRepository.getAll(), transactionRepository.getAll(),
      openingBalanceRepository.getAll(), settingsRepository.getAll(), metadataRepository.getAll(),
      // Phase 4B.6 — the audit trail is part of the data, so it is backed up with it.
      auditLogRepository.getAll(),
      // Phase 4B.11 — the reference catalogues travel with the data they are referenced by.
      receivingCompanyRepository.getAll(), cartonTypeRepository.getAll(),
      // Phase 4B.13.1 — the variety catalogue travels with the movements that reference it.
      strawberryVarietyRepository.getAll()
    ]);
    return {
      Meta: {
        App: BACKUP_APP_ID,
        FormatVersion: BACKUP_FORMAT_VERSION,
        SchemaVersion: DB_VERSION,
        ExportedAt: nowIso()
      },
      Customers: customers,
      Transactions: transactions,
      OpeningBalanceHistory: openingBalanceHistory,
      Settings: settings,
      Metadata: metadata,
      AuditLog: auditLog,
      ReceivingCompanies: receivingCompanies,
      CartonTypes: cartonTypes,
      // Phase 4B.13.1 — an OPTIONAL additive section: an older file (without it) still
      // restores here, and a file carrying it is validated before anything is written.
      StrawberryVarieties: strawberryVarieties
    };
  },

  async createBackupJson(spacing = 0) {
    const backup = await backupService.createBackup();
    await metadataRepository.set(METADATA_KEYS.LAST_BACKUP_AT, nowIso());
    return JSON.stringify(backup, null, spacing);
  },

  async getSummary() {
    const { authService } = await import('./authService.js'); authService.assertCanManageData();
    const [customerCount, transactionCount, openingHistoryCount, settingsCount, metadataCount, auditEntryCount] = await Promise.all([
      customerRepository.count(), transactionRepository.count(), openingBalanceRepository.count(),
      (async () => (await settingsRepository.getAll()).length)(), (async () => (await metadataRepository.getAll()).length)(),
      auditLogRepository.count()
    ]);
    return { customerCount, transactionCount, openingHistoryCount, settingsCount, metadataCount, auditEntryCount };
  }
};

// A stable, sorting-friendly file name derived from the backup timestamp:
// '2026-10-21T09:15:30.123Z' → 'customer-accounts-backup-2026-10-21-0915.json'.
export function backupFileName(exportedAt) {
  const raw = typeof exportedAt === 'string' ? exportedAt : '';
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return 'customer-accounts-backup.json';
  return `customer-accounts-backup-${match[1]}-${match[2]}-${match[3]}-${match[4]}${match[5]}.json`;
}

// Record counts of one backup object, for the screen summary. Pure projection.
export function backupCounts(backup = {}) {
  const count = (value) => (Array.isArray(value) ? value.length : 0);
  return {
    customers: count(backup.Customers),
    transactions: count(backup.Transactions),
    openingBalanceHistory: count(backup.OpeningBalanceHistory),
    settings: count(backup.Settings),
    metadata: count(backup.Metadata),
    auditLog: count(backup.AuditLog),
    receivingCompanies: count(backup.ReceivingCompanies),
    cartonTypes: count(backup.CartonTypes),
    strawberryVarieties: count(backup.StrawberryVarieties)
  };
}

// Phase 4B.10 — the download payload used by the Backup & Restore screen.
// It calls the approved createBackupJson() (so the stored LAST_BACKUP_AT timestamp is
// written exactly as before) and parses it back only to name the file and count rows.
export async function createBackupFile() {
  const json = await backupService.createBackupJson(2);
  const backup = JSON.parse(json);
  return {
    Json: json,
    FileName: backupFileName(backup.Meta && backup.Meta.ExportedAt),
    ExportedAt: (backup.Meta && backup.Meta.ExportedAt) || null,
    FormatVersion: backup.Meta ? backup.Meta.FormatVersion : null,
    SchemaVersion: backup.Meta ? backup.Meta.SchemaVersion : null,
    Counts: backupCounts(backup)
  };
}
