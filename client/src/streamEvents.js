// Every milestone on a polling stream is recorded through a form: who is
// confirming it, plus the fields that matter for that particular step. These
// definitions drive both the entry forms and how a logged event is displayed.

export const EVENT_ORDER = [
  'materials_dispatched', 'materials_arrived', 'agent_arrived', 'boxes_confirmed_empty',
  'polling_opened', 'polling_closed', 'counting_started', 'counting_completed',
  'results_declared', 'materials_departed', 'materials_arrived_tally_centre'
];

export const EVENT_LABEL = {
  materials_dispatched: 'Materials dispatched from tallying centre',
  materials_arrived: 'Materials arrived at station',
  agent_arrived: 'Agent arrived on site',
  boxes_confirmed_empty: 'Ballot boxes confirmed empty and sealed',
  polling_opened: 'Polling declared open',
  polling_closed: 'Polling declared closed',
  counting_started: 'Counting started',
  counting_completed: 'Counting completed',
  results_declared: 'Results declared',
  materials_departed: 'Materials departed station',
  materials_arrived_tally_centre: 'Materials arrived at tallying centre'
};

export const EVENT_FORMS = {
  materials_dispatched: {
    title: 'Materials dispatched',
    help: 'Record the dispatch of election materials from the tallying centre to this station.',
    fields: [
      { key: 'dispatchedFrom', label: 'Dispatched from (tallying centre / RO office)', required: true },
      { key: 'vehicle', label: 'Vehicle registration / reference no.' },
      { key: 'itemsNote', label: 'Items dispatched (summary)' }
    ]
  },
  materials_arrived: {
    title: 'Materials arrived at the station',
    help: 'Confirm the materials reached this station and what condition they were in.',
    fields: [
      { key: 'receivedBy', label: 'Received by (presiding officer)', required: true },
      { key: 'condition', label: 'Condition on arrival', type: 'select', required: true, options: ['All intact', 'Seals broken / tampered', 'Items missing'] },
      { key: 'issues', label: 'Details of any problem' }
    ]
  },
  agent_arrived: {
    title: 'Agent arrived on site',
    help: 'Capture your location and confirm who you reported to.',
    gps: true,
    fields: [
      { key: 'presidingOfficer', label: 'Presiding officer name', required: true },
      { key: 'agentsPresent', label: 'Other party agents present (number)', type: 'number' }
    ]
  },
  polling_opened: {
    title: 'Declare polling open',
    help: 'Every seat\'s ballot box has been recorded, confirmed empty and sealed. Record who declared polling open.',
    fields: [
      { key: 'openedBy', label: 'Declared open by (presiding officer)', required: true },
      { key: 'queueAtOpening', label: 'Voters queueing at opening (approx.)', type: 'number' }
    ]
  },
  polling_closed: {
    title: 'Declare polling closed',
    help: 'The closing seal over each ballot slot has been recorded. Record who declared polling closed.',
    fields: [
      { key: 'closedBy', label: 'Declared closed by (presiding officer)', required: true },
      { key: 'votersInQueueAtClose', label: 'Voters still in the queue at closing time (approx.)', type: 'number' },
      { key: 'lastVoterServed', label: 'Time the last voter was served' }
    ]
  },
  counting_started: {
    title: 'Counting started',
    help: 'The seals have been checked against those applied at sealing. Record who is supervising the count.',
    fields: [
      { key: 'supervisedBy', label: 'Counting supervised by', required: true },
      { key: 'agentsWitnessing', label: 'Party agents witnessing (names)' }
    ]
  },
  materials_departed: {
    title: 'Materials departed the station',
    help: 'Results are in. Record the sealed boxes and forms leaving for the tallying centre.',
    fields: [
      { key: 'transportedBy', label: 'Transported by', required: true },
      { key: 'vehicle', label: 'Vehicle registration / escort' },
      { key: 'destination', label: 'Destination tallying centre' }
    ]
  },
  materials_arrived_tally_centre: {
    title: 'Materials arrived at the tallying centre',
    help: 'Confirm delivery at the constituency tallying centre.',
    fields: [
      { key: 'receivedBy', label: 'Received by (tally centre clerk)', required: true },
      { key: 'receiptNo', label: 'Receipt / reference no.' }
    ]
  }
};

// Human-readable summary of a logged event's fields, for the timeline.
export function summariseDetails(eventType, details = {}) {
  const form = EVENT_FORMS[eventType];
  if (!form) return [];
  return form.fields
    .filter((f) => details[f.key])
    .map((f) => ({ label: f.label.replace(/\s*\(.*\)\s*$/, ''), value: details[f.key] }));
}
