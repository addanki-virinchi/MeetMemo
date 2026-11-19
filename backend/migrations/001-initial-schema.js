// Firestore is schemaless; this records the baseline schema version.
export async function up(db) {
  await db.collection('_meta').doc('schema').set(
    { version: 1, notes: 'users, meetings, meetings/{id}/segments' },
    { merge: true },
  );
}
