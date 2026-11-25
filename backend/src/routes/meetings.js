import { FieldValue, FieldPath } from 'firebase-admin/firestore';
import { db } from '../firebase.js';
import { createMeetingsRouter } from './meetingsRouter.js';

// Route logic lives in meetingsRouter.js (testable without Firebase credentials).
export default createMeetingsRouter({ db, FieldValue, FieldPath });
