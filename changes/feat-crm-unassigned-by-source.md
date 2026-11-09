### Added

- A CRM source may say which users in `crm.<provider>:<account>.unassigned` its sign-in may count as nobody's
  (`CrmSource.unassigned`), asked at every sync under `scope mine`. The sync copies no deal or lead of a user it
  leaves out, narrows the copy to match, and names them in an issue with the reason `crm.unassigned-dropped`.
