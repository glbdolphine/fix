// Shapes of the records the app stores (shared by server/db.ts and server/api.ts), plus the starting values of the suggestion lists.

export interface AppUser {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'user';
  phoneNumber?: string;
  email?: string;
  photoUrl?: string;
  disabled?: boolean;
  createdAt?: string;
}

export interface StoredUser extends AppUser {
  password: string;
}

export interface LogChange {
  at: string;
  by: string;
  action: 'created' | 'edited';
  changes?: { field: string; from: string; to: string }[];
}

export interface LogEntry {
  id: string;
  logNo: number | string;
  date: string;
  foremanName: string;
  requestType: string;
  customerName: string;
  nmsId: string;
  issueFound: string;
  missingWrongDetails: string;
  actionTaken: string;
  reasonForAction: string;
  foremanInformed: string;
  followUpNeeded: string;
  status: string;
  supervisorInformed: string;
  remarks: string;
  mac: string;
  edcNo?: string;
  emisEiinDghs?: string;
  routerSerial?: string;
  formReceivedAt?: string;
  billReceivedAt?: string;
  billMonths?: string[];
  term?: string;
  foremanId?: string;
  followUpDate?: string;
  foremanPhone?: string;
  headTeacherName?: string;
  headTeacherPhone?: string;
  lat?: string;
  long?: string;
  unionName?: string;
  upazila?: string;
  fiberLength?: string;
  category?: string;
  nameBn?: string; // institute name in Bangla (shown in logs)
  nameEn?: string; // institute name in English (kept for reference only)
  upacFormName?: string;
  upacFormData?: string;
  upacFormType?: string;
  upacFormSize?: number;
  upacFormUploadedAt?: string;
  deletedAt?: string;
  deletedBy?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
  history?: LogChange[];
}

export type MarkKind = 'form' | 'bill';
export type MarkAction = 'received' | 'not_received';

export interface ImportRequest {
  id: string;
  requestedBy: string;
  requestedById?: string;
  requestedAt: string;
  status: 'pending' | 'approved' | 'rejected';
  decidedBy?: string;
  decidedAt?: string;
  count: number;
  sample?: string;
}

export interface ApprovalRequest {
  id: string;
  logId: string;
  logNo?: number | string;
  customer?: string;
  kind: MarkKind;
  action: MarkAction;
  requestedBy: string;
  requestedById?: string;
  requestedAt: string;
  status: 'pending' | 'approved' | 'rejected';
  decidedBy?: string;
  decidedAt?: string;
  month?: string;
  receivedOn?: string;
}

export interface Foreman {
  id: string;
  name: string;
  area: string;
  phone: string;
  photoUrl?: string;
  active: boolean;
  roam?: boolean;
  roamAreas?: string[];
  createdAt: string;
  deletedAt?: string;
  deletedBy?: string;
}

export interface TeamMember {
  id: string;
  foremanId: string;
  name: string;
  phone: string;
  role: string;
  active: boolean;
  createdAt: string;
  deletedAt?: string;
  deletedBy?: string;
}

export const ACTIVITY_ACTIONS = ['created', 'edited', 'deleted', 'cleared', 'restored', 'user_created', 'user_disabled', 'user_enabled', 'purged', 'password_reset'] as const;
export interface ActivityEvent {
  id: string;
  at: string;
  by: string;
  action: 'created' | 'edited' | 'deleted' | 'cleared' | 'restored' | 'user_created' | 'user_disabled' | 'user_enabled' | 'purged' | 'password_reset';
  logNo?: number | string;
  customer?: string;
  detail?: string;
}

export type LogFieldKey =
  | 'foremanName'
  | 'foremanPhone'
  | 'requestType'
  | 'customerName'
  | 'nmsId'
  | 'issueFound'
  | 'missingWrongDetails'
  | 'actionTaken'
  | 'reasonForAction'
  | 'foremanInformed'
  | 'followUpNeeded'
  | 'status'
  | 'supervisorInformed'
  | 'remarks'
  | 'mac';

export type FieldSuggestionsMap = Record<LogFieldKey, string[]>;

export const INITIAL_SUGGESTIONS: FieldSuggestionsMap = {
  foremanName: ['Shabul- Balaganj', 'Rahman- Sylhet Sadar', 'Kabir- Beanibazar', 'Alam- Golapganj', 'Faruk- Biswanath'],
  foremanPhone: ['+880 1680-945894', '+880 1711-234567', '+880 1912-345678'],
  requestType: ['New User ID', 'Form Submission', 'Bandwidth Upgrade', 'Router Relocation', 'Profile Modification', 'MAC Binding Reset', 'IP Address Re-assignment'],
  customerName: ['Hasampur Govt. Primary School', 'Radhakona Govt. Primary School', 'Sreemangal Model High School', 'Balaganj Technical Institute'],
  nmsId: [],
  issueFound: ['Same router at two institute', 'MAC address collision in NMS', 'Incorrect package assigned', 'Port link down on OLT', 'VLAN mismatch at foreman switch'],
  missingWrongDetails: ['They previously used the same router in Radhakona Govt. Primary School', 'National ID card copy missing from form', 'Phone number mismatch on application form', 'Previous billing clearance pending'],
  actionTaken: ['Provided the id/form as requested but kept nms entry on hold', 'Created user ID in NMS and notified foreman via WhatsApp', 'Updated MAC binding in authentication server', 'Forwarded ticket to Core NOC team for IP remapping'],
  reasonForAction: ["I did not entry this school in nms because nms doesn't allow two school with same router.", 'Awaiting confirmation of router decommissioning from previous site.', 'Verified payment voucher with accounts before activating profile.'],
  foremanInformed: ['Yes - phone', 'Yes - WhatsApp', 'Yes - email', 'Yes - in-person', 'No - unanswered phone call', 'No - SMS sent'],
  followUpNeeded: ['Yes', 'No', 'Pending foreman callback', 'Pending supervisor review'],
  status: ['Pending - waiting for foreman', 'In Progress', 'Resolved', 'Escalated to Core Team', 'On Hold', 'Closed'],
  supervisorInformed: ['I informed my superiors', 'Approved by Team Lead', 'Informed Operations Manager', 'Escalated to Duty Manager', 'No approval needed (standard request)'],
  remarks: ['Foreman said Radhakona Govt. Primary School is not using the network or the router anymore. So they decided to use it for another school.', 'Foreman promised to submit the formal decommissioning request by tomorrow.', 'Client requested urgent activation before morning classes.'],
  mac: ['20:23:51:78:49:F4', '44:D9:E7:2B:1A:08', 'E4:5F:01:8C:3D:A2'],
};
