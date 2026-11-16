### Fixed

- **`meetings list` and `meetings show` stop when the run is stopped.** A read of the service that the run's stop
  signal cut short was taken as a failed service and answered from the store. Now the stop is the answer, and the
  service's `find` and `get` receive the signal as a new last argument. A host passes `signal` in
  `addMeetingCommands`' deps; `MeetingServerAccess.signal` carries it for a direct call.
