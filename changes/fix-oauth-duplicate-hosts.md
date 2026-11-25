### Fixed

- **`oauthSessionCommand` signs in when the sign-in and the token share one host.** Zoom (`zoom.us`) and Google
  (`oauth2.googleapis.com`) list one host for two of their addresses, and `session start` refused with
  `configuration_error: "zoom.us" is listed twice`. Each host is now allowed once.
