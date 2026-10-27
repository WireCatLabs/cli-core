-- `metadata.recurring_event_id` stays on the rows it is on: a version-34 build may still open this file and reads it.
UPDATE calendar_entries SET series_external_id = json_extract(metadata, '$.recurring_event_id')
  WHERE kind = 'occurrence' AND json_valid(metadata) AND json_extract(metadata, '$.recurring_event_id') IS NOT NULL;
--> statement-breakpoint
UPDATE calendar_entries SET event_type = CASE event_type
    WHEN 'outOfOffice' THEN 'out-of-office'
    WHEN 'focusTime' THEN 'focus'
    WHEN 'workingLocation' THEN 'working-location'
    WHEN 'fromGmail' THEN 'from-mail'
  END
  WHERE event_type IN ('outOfOffice', 'focusTime', 'workingLocation', 'fromGmail');
--> statement-breakpoint
UPDATE calendar_entries SET own_response = 'needs-action' WHERE own_response = 'needsAction';
--> statement-breakpoint
UPDATE calendar_entry_participants SET response = 'needs-action' WHERE response = 'needsAction';
--> statement-breakpoint
UPDATE calendars SET access_role = 'free-busy' WHERE access_role = 'freeBusyReader';
