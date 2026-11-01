// Written by scripts/bundle-migrations.ts from drizzle/ — run `pnpm db:bundle`, do not edit.
export const GENERATED: { name: string; statements: string[] }[] = [
  {
    "name": "20261010184427_initial",
    "statements": [
      "CREATE TABLE `account_identities` (\n\t`account_id` integer NOT NULL,\n\t`identity_id` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`last_messaged_at` integer,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `account_identities_pk` PRIMARY KEY(`account_id`, `identity_id`),\n\tCONSTRAINT `fk_account_identities_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),\n\tCONSTRAINT `fk_account_identities_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`)\n);",
      "CREATE TABLE `accounts` (\n\t`id` integer PRIMARY KEY,\n\t`provider` text NOT NULL,\n\t`external_id` text NOT NULL,\n\t`name` text,\n\t`created_at` integer NOT NULL,\n\t`settings` text,\n\t`status` text,\n\t`updated_at` integer NOT NULL,\n\t`scope` text DEFAULT 'personal' NOT NULL,\n\t`organization_id` integer,\n\tCONSTRAINT `fk_accounts_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`),\n\tCONSTRAINT `accounts_provider_external_id_unique` UNIQUE(`provider`,`external_id`)\n);",
      "CREATE TABLE `agent_actions` (\n\t`id` integer PRIMARY KEY,\n\t`actor_type` text NOT NULL,\n\t`actor_id` integer NOT NULL,\n\t`tool` text NOT NULL,\n\t`tier` text NOT NULL,\n\t`target_type` text,\n\t`target_id` integer,\n\t`status` text NOT NULL,\n\t`error` text,\n\t`started_at` integer NOT NULL,\n\t`finished_at` integer,\n\t`created_at` integer NOT NULL\n);",
      "CREATE TABLE `aliases` (\n\t`id` integer PRIMARY KEY,\n\t`aliasable_type` text NOT NULL,\n\t`aliasable_id` integer NOT NULL,\n\t`account_id` integer,\n\t`name` text NOT NULL,\n\t`name_folded` text NOT NULL,\n\t`display` integer DEFAULT 0 NOT NULL,\n\t`source` text NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `fk_aliases_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`)\n);",
      "CREATE TABLE `attachments` (\n\t`id` integer PRIMARY KEY,\n\t`attachable_type` text NOT NULL,\n\t`attachable_id` integer NOT NULL,\n\t`position` integer NOT NULL,\n\t`kind` text NOT NULL,\n\t`mime` text,\n\t`name` text,\n\t`title` text,\n\t`url` text,\n\t`size` integer,\n\t`width` integer,\n\t`height` integer,\n\t`duration` real,\n\t`provider_ref` text,\n\t`local_path` text,\n\t`text` text,\n\t`normalized_text` text,\n\t`extraction` text,\n\t`extractor` text,\n\t`extraction_error` text,\n\t`content_sha256` text,\n\t`extracted_at` integer,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `attachments_attachable_type_attachable_id_position_unique` UNIQUE(`attachable_type`,`attachable_id`,`position`)\n);",
      "CREATE TABLE `auto_tag_claims` (\n\t`chat_id` integer NOT NULL,\n\t`tag_id` integer NOT NULL,\n\t`algorithm` text NOT NULL,\n\t`score` real NOT NULL,\n\t`fields` text NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `auto_tag_claims_pk` PRIMARY KEY(`chat_id`, `tag_id`),\n\tCONSTRAINT `fk_auto_tag_claims_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`),\n\tCONSTRAINT `fk_auto_tag_claims_tag_id_tags_id_fk` FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`)\n);",
      "CREATE TABLE `bot_updates` (\n\t`id` integer PRIMARY KEY,\n\t`account_id` integer NOT NULL,\n\t`external_id` text NOT NULL,\n\t`kind` text NOT NULL,\n\t`payload` text NOT NULL,\n\t`received_at` integer NOT NULL,\n\t`handled_at` integer,\n\t`error` text,\n\t`replayed_at` integer,\n\t`created_at` integer NOT NULL,\n\tCONSTRAINT `fk_bot_updates_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),\n\tCONSTRAINT `bot_updates_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)\n);",
      "CREATE TABLE `bots` (\n\t`id` integer PRIMARY KEY,\n\t`name` text NOT NULL UNIQUE,\n\t`kind` text NOT NULL,\n\t`description` text,\n\t`owner_person_id` integer,\n\t`model` text,\n\t`token_digest` text,\n\t`last_seen_at` integer,\n\t`disabled_at` integer,\n\t`metadata` text,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `fk_bots_owner_person_id_persons_id_fk` FOREIGN KEY (`owner_person_id`) REFERENCES `persons`(`id`)\n);",
      "CREATE TABLE `chat_members` (\n\t`chat_id` integer NOT NULL,\n\t`identity_id` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\tCONSTRAINT `chat_members_pk` PRIMARY KEY(`chat_id`, `identity_id`),\n\tCONSTRAINT `fk_chat_members_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`),\n\tCONSTRAINT `fk_chat_members_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`)\n);",
      "CREATE TABLE `chats` (\n\t`id` integer PRIMARY KEY,\n\t`account_id` integer NOT NULL,\n\t`external_id` text NOT NULL,\n\t`kind` text NOT NULL,\n\t`title` text,\n\t`unread_count` integer,\n\t`last_message_at` integer,\n\t`participants_count` integer,\n\t`metadata` text,\n\t`updated_at` integer NOT NULL,\n\t`username` text,\n\t`membership_state` text,\n\t`searchable` integer DEFAULT 1 NOT NULL,\n\t`message_count` integer DEFAULT 0 NOT NULL,\n\t`members_tracked_at` integer,\n\t`description` text,\n\t`details_fetched_at` integer,\n\t`created_at` integer NOT NULL,\n\t`parent_chat_id` integer,\n\t`scope` text,\n\tCONSTRAINT `fk_chats_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),\n\tCONSTRAINT `fk_chats_parent_chat_id_chats_id_fk` FOREIGN KEY (`parent_chat_id`) REFERENCES `chats`(`id`),\n\tCONSTRAINT `chats_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)\n);",
      "CREATE TABLE `chunk_messages` (\n\t`chunk_id` integer PRIMARY KEY,\n\t`first_message_id` integer NOT NULL,\n\t`last_message_id` integer NOT NULL,\n\t`text_start` integer,\n\t`text_end` integer,\n\tCONSTRAINT `fk_chunk_messages_chunk_id_chunks_id_fk` FOREIGN KEY (`chunk_id`) REFERENCES `chunks`(`id`) ON DELETE CASCADE,\n\tCONSTRAINT `fk_chunk_messages_first_message_id_messages_id_fk` FOREIGN KEY (`first_message_id`) REFERENCES `messages`(`id`) ON DELETE CASCADE,\n\tCONSTRAINT `fk_chunk_messages_last_message_id_messages_id_fk` FOREIGN KEY (`last_message_id`) REFERENCES `messages`(`id`) ON DELETE CASCADE\n);",
      "CREATE TABLE `chunks` (\n\t`id` integer PRIMARY KEY,\n\t`chunkable_type` text NOT NULL,\n\t`chunkable_id` integer NOT NULL,\n\t`position` integer NOT NULL,\n\t`start_offset` integer NOT NULL,\n\t`end_offset` integer NOT NULL,\n\t`content_hash` text NOT NULL,\n\t`scope` text,\n\t`account_id` integer,\n\t`project_id` integer,\n\t`occurred_at` integer,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `fk_chunks_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),\n\tCONSTRAINT `fk_chunks_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),\n\tCONSTRAINT `chunks_chunkable_type_chunkable_id_position_unique` UNIQUE(`chunkable_type`,`chunkable_id`,`position`)\n);",
      "CREATE TABLE `conversation_messages` (\n\t`conversation_id` integer NOT NULL,\n\t`message_id` integer NOT NULL,\n\tCONSTRAINT `conversation_messages_pk` PRIMARY KEY(`conversation_id`, `message_id`),\n\tCONSTRAINT `fk_conversation_messages_conversation_id_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON DELETE CASCADE,\n\tCONSTRAINT `fk_conversation_messages_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON DELETE CASCADE\n);",
      "CREATE TABLE `conversation_state` (\n\t`chat_id` integer PRIMARY KEY,\n\t`enabled_at` integer NOT NULL,\n\t`built_at` integer,\n\t`algorithm_version` integer,\n\t`current_build` integer,\n\tCONSTRAINT `fk_conversation_state_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON DELETE CASCADE\n);",
      "CREATE TABLE `conversations` (\n\t`id` integer PRIMARY KEY,\n\t`chat_id` integer NOT NULL,\n\t`first_message_id` integer NOT NULL,\n\t`build` integer NOT NULL,\n\t`first_at` integer NOT NULL,\n\t`last_at` integer NOT NULL,\n\t`message_count` integer NOT NULL,\n\t`built_at` integer NOT NULL,\n\t`algorithm_version` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `fk_conversations_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON DELETE CASCADE,\n\tCONSTRAINT `fk_conversations_first_message_id_messages_id_fk` FOREIGN KEY (`first_message_id`) REFERENCES `messages`(`id`) ON DELETE CASCADE\n);",
      "CREATE TABLE `decisions` (\n\t`id` integer PRIMARY KEY,\n\t`project_id` integer,\n\t`statement` text NOT NULL,\n\t`status` text NOT NULL,\n\t`decided_at` integer,\n\t`supersedes_id` integer,\n\t`confirmed_by_type` text,\n\t`confirmed_by_id` integer,\n\t`source` text NOT NULL,\n\t`metadata` text,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\tCONSTRAINT `fk_decisions_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),\n\tCONSTRAINT `fk_decisions_supersedes_id_decisions_id_fk` FOREIGN KEY (`supersedes_id`) REFERENCES `decisions`(`id`)\n);",
      "CREATE TABLE `document_index_pending` (\n\t`id` integer NOT NULL,\n\t`indexable_type` text NOT NULL,\n\tCONSTRAINT `document_index_pending_pk` PRIMARY KEY(`indexable_type`, `id`)\n);",
      "CREATE TABLE `document_revisions` (\n\t`id` integer PRIMARY KEY,\n\t`document_id` integer NOT NULL,\n\t`body` text NOT NULL,\n\t`revision` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\tCONSTRAINT `fk_document_revisions_document_id_documents_id_fk` FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`)\n);",
      "CREATE TABLE `documents` (\n\t`id` integer PRIMARY KEY,\n\t`account_id` integer NOT NULL,\n\t`external_id` text NOT NULL,\n\t`kind` text NOT NULL,\n\t`title` text,\n\t`location` text,\n\t`file_name` text,\n\t`extension` text,\n\t`url` text,\n\t`storage` text,\n\t`local_path` text,\n\t`mime` text,\n\t`size` integer,\n\t`content_hash` text,\n\t`front_matter` text,\n\t`body` text,\n\t`normalized_text` text,\n\t`extraction` text,\n\t`extraction_error` text,\n\t`language` text,\n\t`revision` integer DEFAULT 1 NOT NULL,\n\t`export_path` text,\n\t`external_created_at` integer,\n\t`external_updated_at` integer,\n\t`metadata` text,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\tCONSTRAINT `fk_documents_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),\n\tCONSTRAINT `documents_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)\n);",
      "CREATE TABLE `email_index_pending` (\n\t`id` integer NOT NULL,\n\t`indexable_type` text NOT NULL,\n\tCONSTRAINT `email_index_pending_pk` PRIMARY KEY(`indexable_type`, `id`)\n);",
      "CREATE TABLE `email_mailboxes` (\n\t`email_id` integer NOT NULL,\n\t`mailbox_id` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\tCONSTRAINT `email_mailboxes_pk` PRIMARY KEY(`email_id`, `mailbox_id`),\n\tCONSTRAINT `fk_email_mailboxes_email_id_emails_id_fk` FOREIGN KEY (`email_id`) REFERENCES `emails`(`id`),\n\tCONSTRAINT `fk_email_mailboxes_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`)\n);",
      "CREATE TABLE `email_recipients` (\n\t`id` integer PRIMARY KEY,\n\t`email_id` integer NOT NULL,\n\t`identity_id` integer,\n\t`address` text NOT NULL,\n\t`name` text,\n\t`role` text NOT NULL,\n\t`position` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `fk_email_recipients_email_id_emails_id_fk` FOREIGN KEY (`email_id`) REFERENCES `emails`(`id`),\n\tCONSTRAINT `fk_email_recipients_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`)\n);",
      "CREATE TABLE `email_threads` (\n\t`id` integer PRIMARY KEY,\n\t`account_id` integer NOT NULL,\n\t`external_id` text NOT NULL,\n\t`subject` text,\n\t`last_email_at` integer,\n\t`emails_count` integer DEFAULT 0 NOT NULL,\n\t`metadata` text,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\tCONSTRAINT `fk_email_threads_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),\n\tCONSTRAINT `email_threads_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)\n);",
      "CREATE TABLE `emails` (\n\t`id` integer PRIMARY KEY,\n\t`account_id` integer NOT NULL,\n\t`email_thread_id` integer NOT NULL,\n\t`external_id` text NOT NULL,\n\t`subject` text,\n\t`from_identity_id` integer,\n\t`from_address` text,\n\t`from_name` text,\n\t`sent_at` integer,\n\t`received_at` integer,\n\t`in_reply_to` text,\n\t`references` text,\n\t`body_text` text,\n\t`body_html` text,\n\t`snippet` text,\n\t`outgoing` integer,\n\t`read` integer,\n\t`flagged` integer,\n\t`draft` integer,\n\t`size` integer,\n\t`headers` text,\n\t`metadata` text,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\tCONSTRAINT `fk_emails_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),\n\tCONSTRAINT `fk_emails_email_thread_id_email_threads_id_fk` FOREIGN KEY (`email_thread_id`) REFERENCES `email_threads`(`id`),\n\tCONSTRAINT `fk_emails_from_identity_id_identities_id_fk` FOREIGN KEY (`from_identity_id`) REFERENCES `identities`(`id`),\n\tCONSTRAINT `emails_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)\n);",
      "CREATE TABLE `embeddings` (\n\t`model` text NOT NULL,\n\t`content_hash` text NOT NULL,\n\t`dims` integer NOT NULL,\n\t`vector` blob NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `embeddings_pk` PRIMARY KEY(`model`, `content_hash`)\n);",
      "CREATE TABLE `event_series` (\n\t`id` integer PRIMARY KEY,\n\t`title` text,\n\t`recurrence` text,\n\t`origin` text NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL\n);",
      "CREATE TABLE `events` (\n\t`id` integer PRIMARY KEY,\n\t`event_series_id` integer,\n\t`title` text,\n\t`description` text,\n\t`location` text,\n\t`starts_at` integer,\n\t`ends_at` integer,\n\t`timezone` text,\n\t`origin` text NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\tCONSTRAINT `fk_events_event_series_id_event_series_id_fk` FOREIGN KEY (`event_series_id`) REFERENCES `event_series`(`id`)\n);",
      "CREATE TABLE `fetch_leases` (\n\t`chat_id` integer NOT NULL,\n\t`anchor` text NOT NULL,\n\t`holder` text NOT NULL,\n\t`expires_at` integer NOT NULL,\n\tCONSTRAINT `fetch_leases_pk` PRIMARY KEY(`chat_id`, `anchor`),\n\tCONSTRAINT `fk_fetch_leases_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`)\n);",
      "CREATE TABLE `identities` (\n\t`id` integer PRIMARY KEY,\n\t`provider` text NOT NULL,\n\t`external_id` text NOT NULL,\n\t`username` text,\n\t`name` text,\n\t`bot` integer,\n\t`phone_hmac` text,\n\t`metadata` text,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`description` text,\n\tCONSTRAINT `identities_provider_external_id_unique` UNIQUE(`provider`,`external_id`)\n);",
      "CREATE TABLE `identity_link_events` (\n\t`id` integer PRIMARY KEY,\n\t`identity_id` integer NOT NULL,\n\t`from_person_id` integer,\n\t`to_person_id` integer NOT NULL,\n\t`method` text NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`author` text NOT NULL,\n\tCONSTRAINT `fk_identity_link_events_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`),\n\tCONSTRAINT `fk_identity_link_events_from_person_id_persons_id_fk` FOREIGN KEY (`from_person_id`) REFERENCES `persons`(`id`),\n\tCONSTRAINT `fk_identity_link_events_to_person_id_persons_id_fk` FOREIGN KEY (`to_person_id`) REFERENCES `persons`(`id`)\n);",
      "CREATE TABLE `identity_links` (\n\t`identity_id` integer PRIMARY KEY,\n\t`person_id` integer NOT NULL,\n\t`method` text NOT NULL,\n\t`confidence` real NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`author` text NOT NULL,\n\t`source` text,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `fk_identity_links_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`),\n\tCONSTRAINT `fk_identity_links_person_id_persons_id_fk` FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`)\n);",
      "CREATE TABLE `identity_revisions` (\n\t`id` integer PRIMARY KEY,\n\t`identity_id` integer NOT NULL,\n\t`name` text,\n\t`username` text,\n\t`description` text,\n\t`marks` text,\n\t`created_at` integer NOT NULL,\n\tCONSTRAINT `fk_identity_revisions_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`)\n);",
      "CREATE TABLE `involvement_pending` (\n\t`id` integer NOT NULL,\n\t`indexable_type` text NOT NULL,\n\tCONSTRAINT `involvement_pending_pk` PRIMARY KEY(`indexable_type`, `id`)\n);",
      "CREATE TABLE `involvements` (\n\t`id` integer PRIMARY KEY,\n\t`person_id` integer,\n\t`identity_id` integer,\n\t`subject_type` text NOT NULL,\n\t`subject_id` integer NOT NULL,\n\t`role` text NOT NULL,\n\t`occurred_at` integer NOT NULL,\n\t`scope` text NOT NULL,\n\t`account_id` integer,\n\t`project_id` integer,\n\t`created_at` integer NOT NULL,\n\tCONSTRAINT `fk_involvements_person_id_persons_id_fk` FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`),\n\tCONSTRAINT `fk_involvements_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`),\n\tCONSTRAINT `fk_involvements_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),\n\tCONSTRAINT `fk_involvements_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`)\n);",
      "CREATE TABLE `links` (\n\t`id` integer PRIMARY KEY,\n\t`from_type` text NOT NULL,\n\t`from_id` integer NOT NULL,\n\t`to_type` text,\n\t`to_id` integer,\n\t`kind` text NOT NULL,\n\t`anchor` text,\n\t`source` text NOT NULL,\n\t`target_text` text,\n\t`target_folded` text,\n\t`role` text,\n\t`evidence` text,\n\t`metadata` text,\n\t`confirmed` integer DEFAULT 1 NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`author` text,\n\t`updated_at` integer NOT NULL\n);",
      "CREATE TABLE `mailboxes` (\n\t`id` integer PRIMARY KEY,\n\t`account_id` integer NOT NULL,\n\t`external_id` text NOT NULL,\n\t`name` text NOT NULL,\n\t`kind` text,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `fk_mailboxes_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),\n\tCONSTRAINT `mailboxes_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)\n);",
      "CREATE TABLE `meeting_chat_messages` (\n\t`id` integer PRIMARY KEY,\n\t`meeting_id` integer NOT NULL,\n\t`external_id` text,\n\t`sent_at` integer NOT NULL,\n\t`sender_participant_id` integer,\n\t`sender_name` text,\n\t`recipient` text,\n\t`text` text NOT NULL,\n\t`normalized_text` text,\n\t`metadata` text,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `fk_meeting_chat_messages_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`),\n\tCONSTRAINT `fk_meeting_chat_messages_sender_participant_id_meeting_participants_id_fk` FOREIGN KEY (`sender_participant_id`) REFERENCES `meeting_participants`(`id`)\n);",
      "CREATE TABLE `meeting_index_pending` (\n\t`id` integer NOT NULL,\n\t`indexable_type` text NOT NULL,\n\tCONSTRAINT `meeting_index_pending_pk` PRIMARY KEY(`indexable_type`, `id`)\n);",
      "CREATE TABLE `meeting_participants` (\n\t`id` integer PRIMARY KEY,\n\t`meeting_id` integer NOT NULL,\n\t`identity_id` integer NOT NULL,\n\t`display_name` text,\n\t`email` text,\n\t`role` text,\n\t`joined_at` integer,\n\t`left_at` integer,\n\t`duration_ms` integer,\n\t`sessions` text,\n\t`external_id` text,\n\t`metadata` text,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `fk_meeting_participants_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`),\n\tCONSTRAINT `fk_meeting_participants_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`),\n\tCONSTRAINT `meeting_participants_meeting_id_identity_id_unique` UNIQUE(`meeting_id`,`identity_id`)\n);",
      "CREATE TABLE `meeting_series` (\n\t`id` integer PRIMARY KEY,\n\t`account_id` integer NOT NULL,\n\t`external_id` text NOT NULL,\n\t`event_series_id` integer,\n\t`title` text,\n\t`description` text,\n\t`kind` text,\n\t`recurrence` text,\n\t`host_identity_id` integer,\n\t`join_url` text,\n\t`metadata` text,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\tCONSTRAINT `fk_meeting_series_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),\n\tCONSTRAINT `fk_meeting_series_event_series_id_event_series_id_fk` FOREIGN KEY (`event_series_id`) REFERENCES `event_series`(`id`),\n\tCONSTRAINT `fk_meeting_series_host_identity_id_identities_id_fk` FOREIGN KEY (`host_identity_id`) REFERENCES `identities`(`id`),\n\tCONSTRAINT `meeting_series_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)\n);",
      "CREATE TABLE `meeting_summaries` (\n\t`id` integer PRIMARY KEY,\n\t`meeting_id` integer NOT NULL,\n\t`source` text NOT NULL,\n\t`title` text,\n\t`overview` text,\n\t`sections` text,\n\t`next_steps` text,\n\t`content` text,\n\t`doc_url` text,\n\t`external_created_at` integer,\n\t`external_updated_at` integer,\n\t`metadata` text,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `fk_meeting_summaries_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`),\n\tCONSTRAINT `meeting_summaries_meeting_id_source_unique` UNIQUE(`meeting_id`,`source`)\n);",
      "CREATE TABLE `meeting_transcript_rows` (\n\t`id` integer PRIMARY KEY,\n\t`meeting_transcript_id` integer NOT NULL,\n\t`position` integer NOT NULL,\n\t`start_ms` integer NOT NULL,\n\t`end_ms` integer NOT NULL,\n\t`speaker_participant_id` integer,\n\t`speaker_name` text,\n\t`text` text NOT NULL,\n\t`normalized_text` text,\n\t`metadata` text,\n\t`created_at` integer NOT NULL,\n\tCONSTRAINT `fk_meeting_transcript_rows_meeting_transcript_id_meeting_transcripts_id_fk` FOREIGN KEY (`meeting_transcript_id`) REFERENCES `meeting_transcripts`(`id`),\n\tCONSTRAINT `fk_meeting_transcript_rows_speaker_participant_id_meeting_participants_id_fk` FOREIGN KEY (`speaker_participant_id`) REFERENCES `meeting_participants`(`id`),\n\tCONSTRAINT `meeting_transcript_rows_meeting_transcript_id_position_unique` UNIQUE(`meeting_transcript_id`,`position`)\n);",
      "CREATE TABLE `meeting_transcripts` (\n\t`id` integer PRIMARY KEY,\n\t`meeting_id` integer NOT NULL,\n\t`source` text NOT NULL,\n\t`format` text,\n\t`language` text,\n\t`content_hash` text,\n\t`external_created_at` integer,\n\t`superseded_at` integer,\n\t`metadata` text,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\tCONSTRAINT `fk_meeting_transcripts_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`)\n);",
      "CREATE TABLE `meetings` (\n\t`id` integer PRIMARY KEY,\n\t`account_id` integer NOT NULL,\n\t`meeting_series_id` integer,\n\t`event_id` integer,\n\t`external_id` text NOT NULL,\n\t`title` text,\n\t`description` text,\n\t`location` text,\n\t`join_url` text,\n\t`started_at` integer,\n\t`ended_at` integer,\n\t`duration_ms` integer,\n\t`timezone` text,\n\t`host_identity_id` integer,\n\t`participants_count` integer,\n\t`metadata` text,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\tCONSTRAINT `fk_meetings_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),\n\tCONSTRAINT `fk_meetings_meeting_series_id_meeting_series_id_fk` FOREIGN KEY (`meeting_series_id`) REFERENCES `meeting_series`(`id`),\n\tCONSTRAINT `fk_meetings_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`),\n\tCONSTRAINT `fk_meetings_host_identity_id_identities_id_fk` FOREIGN KEY (`host_identity_id`) REFERENCES `identities`(`id`),\n\tCONSTRAINT `meetings_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)\n);",
      "CREATE TABLE `member_counts` (\n\t`chat_id` integer NOT NULL,\n\t`date` text NOT NULL,\n\t`reported_count` integer,\n\t`listed_count` integer NOT NULL,\n\t`complete_list` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\tCONSTRAINT `member_counts_pk` PRIMARY KEY(`chat_id`, `date`),\n\tCONSTRAINT `fk_member_counts_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`)\n);",
      "CREATE TABLE `member_observation_members` (\n\t`member_observation_id` integer NOT NULL,\n\t`identity_id` integer NOT NULL,\n\t`member_stay_id` integer NOT NULL,\n\tCONSTRAINT `member_observation_members_pk` PRIMARY KEY(`member_observation_id`, `identity_id`),\n\tCONSTRAINT `fk_member_observation_members_member_observation_id_member_observations_id_fk` FOREIGN KEY (`member_observation_id`) REFERENCES `member_observations`(`id`),\n\tCONSTRAINT `fk_member_observation_members_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`),\n\tCONSTRAINT `fk_member_observation_members_member_stay_id_member_stays_id_fk` FOREIGN KEY (`member_stay_id`) REFERENCES `member_stays`(`id`)\n);",
      "CREATE TABLE `member_observations` (\n\t`id` integer PRIMARY KEY,\n\t`chat_id` integer NOT NULL,\n\t`observed_at` integer NOT NULL,\n\t`started_at` integer,\n\t`complete` integer NOT NULL,\n\t`reported_count` integer,\n\t`listed_count` integer NOT NULL,\n\t`source` text NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `fk_member_observations_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`)\n);",
      "CREATE TABLE `member_stays` (\n\t`id` integer PRIMARY KEY,\n\t`chat_id` integer NOT NULL,\n\t`identity_id` integer NOT NULL,\n\t`first_seen_at` integer NOT NULL,\n\t`last_seen_at` integer NOT NULL,\n\t`joined_at` integer,\n\t`invited_by_identity_id` integer,\n\t`role` text,\n\t`left_at` integer,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `fk_member_stays_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`),\n\tCONSTRAINT `fk_member_stays_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`),\n\tCONSTRAINT `fk_member_stays_invited_by_identity_id_identities_id_fk` FOREIGN KEY (`invited_by_identity_id`) REFERENCES `identities`(`id`)\n);",
      "CREATE TABLE `memories` (\n\t`id` integer PRIMARY KEY,\n\t`kind` text NOT NULL,\n\t`body` text NOT NULL,\n\t`subject_type` text,\n\t`subject_id` integer,\n\t`author_type` text NOT NULL,\n\t`author_id` integer NOT NULL,\n\t`model` text,\n\t`confidence` real,\n\t`status` text NOT NULL,\n\t`last_verified_at` integer,\n\t`supersedes_id` integer,\n\t`scope` text NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `fk_memories_supersedes_id_memories_id_fk` FOREIGN KEY (`supersedes_id`) REFERENCES `memories`(`id`)\n);",
      "CREATE TABLE `memory_index_pending` (\n\t`id` integer NOT NULL,\n\t`indexable_type` text NOT NULL,\n\tCONSTRAINT `memory_index_pending_pk` PRIMARY KEY(`indexable_type`, `id`)\n);",
      "CREATE TABLE `message_counter_observations` (\n\t`message_id` integer NOT NULL,\n\t`counter` text NOT NULL,\n\t`value` real NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`source` text NOT NULL,\n\tCONSTRAINT `message_counter_observations_pk` PRIMARY KEY(`message_id`, `counter`),\n\tCONSTRAINT `fk_message_counter_observations_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON DELETE CASCADE\n);",
      "CREATE TABLE `message_links` (\n\t`id` integer PRIMARY KEY,\n\t`chat_id` integer NOT NULL,\n\t`message_id` integer NOT NULL,\n\t`parent_id` integer,\n\t`source` text NOT NULL,\n\t`kind` text NOT NULL,\n\t`confidence` real NOT NULL,\n\t`method` text NOT NULL,\n\t`version` text,\n\t`batch` text,\n\t`build` integer,\n\t`created_at` integer NOT NULL,\n\t`stale_at` integer,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `fk_message_links_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON DELETE CASCADE,\n\tCONSTRAINT `fk_message_links_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON DELETE CASCADE,\n\tCONSTRAINT `fk_message_links_parent_id_messages_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `messages`(`id`) ON DELETE CASCADE\n);",
      "CREATE TABLE `message_revisions` (\n\t`id` integer PRIMARY KEY,\n\t`message_id` integer NOT NULL,\n\t`text` text NOT NULL,\n\t`edited_at` integer,\n\t`created_at` integer NOT NULL,\n\tCONSTRAINT `fk_message_revisions_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`)\n);",
      "CREATE TABLE `message_stems_pending` (\n\t`id` integer PRIMARY KEY\n);",
      "CREATE TABLE `message_transcripts` (\n\t`id` integer PRIMARY KEY,\n\t`message_id` integer,\n\t`chat_id` integer NOT NULL,\n\t`message_external_id` text NOT NULL,\n\t`text` text NOT NULL,\n\t`source` text NOT NULL,\n\t`heard_at` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `fk_message_transcripts_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`),\n\tCONSTRAINT `fk_message_transcripts_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`),\n\tCONSTRAINT `message_transcripts_chat_id_message_external_id_unique` UNIQUE(`chat_id`,`message_external_id`)\n);",
      "CREATE TABLE `messages` (\n\t`id` integer PRIMARY KEY,\n\t`chat_id` integer NOT NULL,\n\t`account_id` integer NOT NULL,\n\t`external_id` text NOT NULL,\n\t`thread_external_id` text,\n\t`sender_identity_id` integer,\n\t`sender_chat_external_id` text,\n\t`sender_name` text,\n\t`sent_at` integer NOT NULL,\n\t`edited_at` integer,\n\t`deleted_at` integer,\n\t`text` text NOT NULL,\n\t`reply_to_external_id` text,\n\t`reply_to` text,\n\t`forward` text,\n\t`outgoing` integer,\n\t`reactions` text,\n\t`metadata` text,\n\t`created_at` integer NOT NULL,\n\t`source` text NOT NULL,\n\t`normalized_text` text,\n\t`normalizer_version` integer,\n\t`mentions` text,\n\t`updated_at` integer NOT NULL,\n\t`thread_root_id` integer,\n\tCONSTRAINT `fk_messages_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`),\n\tCONSTRAINT `fk_messages_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),\n\tCONSTRAINT `fk_messages_sender_identity_id_identities_id_fk` FOREIGN KEY (`sender_identity_id`) REFERENCES `identities`(`id`),\n\tCONSTRAINT `fk_messages_thread_root_id_messages_id_fk` FOREIGN KEY (`thread_root_id`) REFERENCES `messages`(`id`),\n\tCONSTRAINT `messages_chat_id_external_id_unique` UNIQUE(`chat_id`,`external_id`)\n);",
      "CREATE TABLE `note_index_pending` (\n\t`id` integer NOT NULL,\n\t`indexable_type` text NOT NULL,\n\tCONSTRAINT `note_index_pending_pk` PRIMARY KEY(`indexable_type`, `id`)\n);",
      "CREATE TABLE `note_revisions` (\n\t`id` integer PRIMARY KEY,\n\t`note_id` integer NOT NULL,\n\t`body` text NOT NULL,\n\t`revision` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\tCONSTRAINT `fk_note_revisions_note_id_notes_id_fk` FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`)\n);",
      "CREATE TABLE `notes` (\n\t`id` integer PRIMARY KEY,\n\t`notable_type` text NOT NULL,\n\t`notable_id` integer NOT NULL,\n\t`title` text,\n\t`body` text NOT NULL,\n\t`author_type` text,\n\t`author_id` integer,\n\t`revision` integer DEFAULT 1 NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer\n);",
      "CREATE TABLE `organizations` (\n\t`id` integer PRIMARY KEY,\n\t`kind` text NOT NULL,\n\t`name` text NOT NULL,\n\t`scope` text DEFAULT 'personal' NOT NULL,\n\t`metadata` text,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer\n);",
      "CREATE TABLE `persons` (\n\t`id` integer PRIMARY KEY,\n\t`name` text,\n\t`owner` integer DEFAULT 0 NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL\n);",
      "CREATE TABLE `projects` (\n\t`id` integer PRIMARY KEY,\n\t`key` text NOT NULL UNIQUE,\n\t`name` text NOT NULL,\n\t`description` text,\n\t`type` text NOT NULL,\n\t`organization_id` integer,\n\t`account_id` integer,\n\t`scope` text DEFAULT 'personal' NOT NULL,\n\t`owner_type` text,\n\t`owner_id` integer,\n\t`tasks_count` integer DEFAULT 0 NOT NULL,\n\t`status` text,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\tCONSTRAINT `fk_projects_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`),\n\tCONSTRAINT `fk_projects_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`)\n);",
      "CREATE TABLE `proposed_actions` (\n\t`id` integer PRIMARY KEY,\n\t`kind` text NOT NULL,\n\t`account_id` integer,\n\t`target_type` text,\n\t`target_id` integer,\n\t`payload` text,\n\t`reason` text,\n\t`status` text NOT NULL,\n\t`proposed_by_type` text NOT NULL,\n\t`proposed_by_id` integer NOT NULL,\n\t`decided_by_type` text,\n\t`decided_by_id` integer,\n\t`decided_at` integer,\n\t`executed_at` integer,\n\t`result` text,\n\t`error` text,\n\t`verdict` text,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `fk_proposed_actions_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`)\n);",
      "CREATE TABLE `reminders` (\n\t`id` integer PRIMARY KEY,\n\t`task_id` integer NOT NULL,\n\t`account_id` integer NOT NULL,\n\t`due_at` integer NOT NULL,\n\t`timezone` text NOT NULL,\n\t`state` text NOT NULL,\n\t`revision` integer DEFAULT 1 NOT NULL,\n\t`lease_until` integer,\n\t`receipt` text,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `fk_reminders_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`),\n\tCONSTRAINT `fk_reminders_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`)\n);",
      "CREATE TABLE `search_index_state` (\n\t`name` text PRIMARY KEY,\n\t`watermark` integer NOT NULL,\n\t`filled_through` integer NOT NULL,\n\t`terms_through` integer NOT NULL,\n\t`normalizer_version` integer NOT NULL,\n\t`built_at` integer,\n\t`analyzer` text\n);",
      "CREATE TABLE `searches` (\n\t`id` integer PRIMARY KEY,\n\t`name` text UNIQUE,\n\t`command` text NOT NULL,\n\t`params` text NOT NULL,\n\t`language` text NOT NULL,\n\t`version` integer NOT NULL,\n\t`fields_version` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`last_run_at` integer,\n\t`runs` integer DEFAULT 0 NOT NULL,\n\t`updated_at` integer NOT NULL\n);",
      "CREATE TABLE `store_settings` (\n\t`key` text PRIMARY KEY,\n\t`value` text NOT NULL,\n\t`at` integer NOT NULL\n);",
      "CREATE TABLE `sync_cursors` (\n\t`account_id` integer NOT NULL,\n\t`key` text NOT NULL,\n\t`value` text NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\tCONSTRAINT `sync_cursors_pk` PRIMARY KEY(`account_id`, `key`),\n\tCONSTRAINT `fk_sync_cursors_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`)\n);",
      "CREATE TABLE `sync_ranges` (\n\t`chat_id` integer NOT NULL,\n\t`from_key` integer NOT NULL,\n\t`to_key` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `sync_ranges_pk` PRIMARY KEY(`chat_id`, `from_key`),\n\tCONSTRAINT `fk_sync_ranges_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`)\n);",
      "CREATE TABLE `syncs` (\n\t`id` integer PRIMARY KEY,\n\t`account_id` integer NOT NULL,\n\t`kind` text NOT NULL,\n\t`started_at` integer NOT NULL,\n\t`finished_at` integer,\n\t`status` text NOT NULL,\n\t`counts` text,\n\t`error` text,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `fk_syncs_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`)\n);",
      "CREATE TABLE `taggings` (\n\t`id` integer PRIMARY KEY,\n\t`tag_id` integer NOT NULL,\n\t`taggable_type` text NOT NULL,\n\t`taggable_id` integer NOT NULL,\n\t`main` integer DEFAULT 0 NOT NULL,\n\t`source` text NOT NULL,\n\t`author_type` text,\n\t`author_id` integer,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `fk_taggings_tag_id_tags_id_fk` FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`),\n\tCONSTRAINT `taggings_tag_id_taggable_type_taggable_id_unique` UNIQUE(`tag_id`,`taggable_type`,`taggable_id`)\n);",
      "CREATE TABLE `tags` (\n\t`id` integer PRIMARY KEY,\n\t`name` text NOT NULL UNIQUE,\n\t`kind` text DEFAULT 'tag' NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL\n);",
      "CREATE TABLE `task_assignments` (\n\t`id` integer PRIMARY KEY,\n\t`task_id` integer NOT NULL,\n\t`assignee_type` text NOT NULL,\n\t`assignee_id` integer NOT NULL,\n\t`role` text NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `fk_task_assignments_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`),\n\tCONSTRAINT `task_assignments_task_id_assignee_type_assignee_id_role_unique` UNIQUE(`task_id`,`assignee_type`,`assignee_id`,`role`)\n);",
      "CREATE TABLE `task_events` (\n\t`id` integer PRIMARY KEY,\n\t`task_id` integer NOT NULL,\n\t`actor_type` text,\n\t`actor_id` integer,\n\t`kind` text NOT NULL,\n\t`changes` text,\n\t`created_at` integer NOT NULL,\n\tCONSTRAINT `fk_task_events_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`)\n);",
      "CREATE TABLE `tasks` (\n\t`id` integer PRIMARY KEY,\n\t`project_id` integer NOT NULL,\n\t`number` integer NOT NULL,\n\t`key` text NOT NULL UNIQUE,\n\t`title` text NOT NULL,\n\t`description` text,\n\t`type` text NOT NULL,\n\t`status` text NOT NULL,\n\t`priority` integer,\n\t`parent_id` integer,\n\t`due_at` integer,\n\t`started_at` integer,\n\t`closed_at` integer,\n\t`closed_by_type` text,\n\t`closed_by_id` integer,\n\t`close_reason` text,\n\t`author_type` text NOT NULL,\n\t`author_id` integer NOT NULL,\n\t`source` text NOT NULL,\n\t`package_id` text UNIQUE,\n\t`source_locator` text,\n\t`source_kind` text,\n\t`source_group` text,\n\t`resolution` text,\n\t`verdict` text,\n\t`metadata` text,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\tCONSTRAINT `fk_tasks_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),\n\tCONSTRAINT `fk_tasks_parent_id_tasks_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `tasks`(`id`),\n\tCONSTRAINT `tasks_project_id_number_unique` UNIQUE(`project_id`,`number`)\n);",
      "CREATE INDEX `account_identities_by_identity_id` ON `account_identities` (`identity_id`);",
      "CREATE INDEX `accounts_by_organization_id` ON `accounts` (`organization_id`);",
      "CREATE INDEX `agent_actions_by_started_at_desc` ON `agent_actions` (\"started_at\" desc);",
      "CREATE INDEX `agent_actions_by_actor_type_actor_id` ON `agent_actions` (`actor_type`,`actor_id`);",
      "CREATE INDEX `agent_actions_by_target_type_target_id` ON `agent_actions` (`target_type`,`target_id`);",
      "CREATE UNIQUE INDEX `aliases_displayed` ON `aliases` (`aliasable_type`,`aliasable_id`,ifnull(\"account_id\", 0)) WHERE display = 1;",
      "CREATE INDEX `aliases_by_aliasable_type_aliasable_id` ON `aliases` (`aliasable_type`,`aliasable_id`);",
      "CREATE INDEX `aliases_by_account_id` ON `aliases` (`account_id`);",
      "CREATE INDEX `auto_tag_claims_by_tag_id` ON `auto_tag_claims` (`tag_id`);",
      "CREATE INDEX `bot_updates_by_account_id_received_at_desc` ON `bot_updates` (`account_id`,\"received_at\" desc);",
      "CREATE INDEX `bots_by_owner_person_id` ON `bots` (`owner_person_id`);",
      "CREATE INDEX `chat_members_by_identity_id` ON `chat_members` (`identity_id`);",
      "CREATE INDEX `chats_by_recency` ON `chats` (`account_id`,\"last_message_at\" desc);",
      "CREATE INDEX `chats_by_parent_chat_id` ON `chats` (`parent_chat_id`);",
      "CREATE INDEX `chunk_messages_by_first_message_id` ON `chunk_messages` (`first_message_id`);",
      "CREATE INDEX `chunk_messages_by_last_message_id` ON `chunk_messages` (`last_message_id`);",
      "CREATE INDEX `chunks_by_content_hash` ON `chunks` (`content_hash`);",
      "CREATE INDEX `chunks_by_scope_occurred_at` ON `chunks` (`scope`,`occurred_at`);",
      "CREATE INDEX `chunks_by_account_id` ON `chunks` (`account_id`);",
      "CREATE INDEX `chunks_by_project_id` ON `chunks` (`project_id`);",
      "CREATE INDEX `conversation_messages_by_message_id` ON `conversation_messages` (`message_id`);",
      "CREATE INDEX `conversations_by_chat` ON `conversations` (`chat_id`,`build`,`first_at`);",
      "CREATE INDEX `conversations_by_first_message_id` ON `conversations` (`first_message_id`);",
      "CREATE INDEX `decisions_by_project_id` ON `decisions` (`project_id`);",
      "CREATE INDEX `decisions_by_supersedes_id` ON `decisions` (`supersedes_id`);",
      "CREATE INDEX `decisions_by_confirmed_by_type_confirmed_by_id` ON `decisions` (`confirmed_by_type`,`confirmed_by_id`);",
      "CREATE INDEX `document_revisions_by_document_id` ON `document_revisions` (`document_id`);",
      "CREATE INDEX `email_mailboxes_by_mailbox_id` ON `email_mailboxes` (`mailbox_id`);",
      "CREATE INDEX `email_recipients_by_email_id` ON `email_recipients` (`email_id`);",
      "CREATE INDEX `email_recipients_by_identity_id` ON `email_recipients` (`identity_id`);",
      "CREATE INDEX `emails_by_time` ON `emails` (`account_id`,\"sent_at\" desc);",
      "CREATE INDEX `emails_by_email_thread_id` ON `emails` (`email_thread_id`);",
      "CREATE INDEX `emails_by_from_identity_id` ON `emails` (`from_identity_id`);",
      "CREATE INDEX `events_by_time` ON `events` (`starts_at`);",
      "CREATE INDEX `events_by_event_series_id` ON `events` (`event_series_id`);",
      "CREATE INDEX `identity_link_events_by_identity_id` ON `identity_link_events` (`identity_id`);",
      "CREATE INDEX `identity_link_events_by_from_person_id` ON `identity_link_events` (`from_person_id`);",
      "CREATE INDEX `identity_link_events_by_to_person_id` ON `identity_link_events` (`to_person_id`);",
      "CREATE INDEX `identity_links_by_person_id` ON `identity_links` (`person_id`);",
      "CREATE INDEX `identity_revisions_by_identity` ON `identity_revisions` (`identity_id`,`created_at`);",
      "CREATE INDEX `involvements_by_person` ON `involvements` (`person_id`,\"occurred_at\" desc);",
      "CREATE INDEX `involvements_by_identity` ON `involvements` (`identity_id`,\"occurred_at\" desc);",
      "CREATE INDEX `involvements_by_subject_type_subject_id` ON `involvements` (`subject_type`,`subject_id`);",
      "CREATE INDEX `involvements_by_account_id` ON `involvements` (`account_id`);",
      "CREATE INDEX `involvements_by_project_id` ON `involvements` (`project_id`);",
      "CREATE INDEX `links_unresolved` ON `links` (`target_folded`) WHERE to_id IS NULL;",
      "CREATE INDEX `links_by_from_type_from_id` ON `links` (`from_type`,`from_id`);",
      "CREATE INDEX `links_by_to_type_to_id` ON `links` (`to_type`,`to_id`);",
      "CREATE UNIQUE INDEX `meeting_chat_messages_by_meeting_id_external_id` ON `meeting_chat_messages` (`meeting_id`,`external_id`) WHERE external_id IS NOT NULL;",
      "CREATE INDEX `meeting_chat_messages_by_meeting_id` ON `meeting_chat_messages` (`meeting_id`);",
      "CREATE INDEX `meeting_chat_messages_by_sender_participant_id` ON `meeting_chat_messages` (`sender_participant_id`);",
      "CREATE INDEX `meeting_participants_by_identity_id` ON `meeting_participants` (`identity_id`);",
      "CREATE INDEX `meeting_series_by_event_series_id` ON `meeting_series` (`event_series_id`);",
      "CREATE INDEX `meeting_series_by_host_identity_id` ON `meeting_series` (`host_identity_id`);",
      "CREATE INDEX `meeting_transcript_rows_by_speaker_participant_id` ON `meeting_transcript_rows` (`speaker_participant_id`);",
      "CREATE INDEX `meeting_transcripts_by_meeting_id` ON `meeting_transcripts` (`meeting_id`);",
      "CREATE INDEX `meetings_by_time` ON `meetings` (`account_id`,\"started_at\" desc);",
      "CREATE INDEX `meetings_by_meeting_series_id` ON `meetings` (`meeting_series_id`);",
      "CREATE INDEX `meetings_by_event_id` ON `meetings` (`event_id`);",
      "CREATE INDEX `meetings_by_host_identity_id` ON `meetings` (`host_identity_id`);",
      "CREATE INDEX `member_observation_members_by_member_stay_id` ON `member_observation_members` (`member_stay_id`);",
      "CREATE INDEX `member_observation_members_by_identity_id` ON `member_observation_members` (`identity_id`);",
      "CREATE INDEX `member_observations_by_chat_id_observed_at_id` ON `member_observations` (`chat_id`,`observed_at`,`id`);",
      "CREATE UNIQUE INDEX `member_stays_open` ON `member_stays` (`chat_id`,`identity_id`) WHERE left_at IS NULL;",
      "CREATE INDEX `member_stays_by_identity_id` ON `member_stays` (`identity_id`);",
      "CREATE INDEX `member_stays_by_invited_by_identity_id` ON `member_stays` (`invited_by_identity_id`);",
      "CREATE INDEX `memories_by_subject_type_subject_id` ON `memories` (`subject_type`,`subject_id`);",
      "CREATE INDEX `memories_by_author_type_author_id` ON `memories` (`author_type`,`author_id`);",
      "CREATE INDEX `memories_by_supersedes_id` ON `memories` (`supersedes_id`);",
      "CREATE UNIQUE INDEX `message_links_unique` ON `message_links` (`message_id`,ifnull(\"parent_id\", 0),`source`,`kind`,ifnull(\"build\", 0));",
      "CREATE INDEX `message_links_by_build` ON `message_links` (`chat_id`,`build`);",
      "CREATE INDEX `message_links_by_parent_id` ON `message_links` (`parent_id`);",
      "CREATE INDEX `message_revisions_by_message_id` ON `message_revisions` (`message_id`);",
      "CREATE INDEX `message_transcripts_by_message_id` ON `message_transcripts` (`message_id`);",
      "CREATE INDEX `messages_by_time` ON `messages` (`chat_id`,\"sent_at\" desc);",
      "CREATE INDEX `messages_by_reply` ON `messages` (`chat_id`,`reply_to_external_id`) WHERE reply_to_external_id IS NOT NULL AND deleted_at IS NULL;",
      "CREATE INDEX `messages_by_account` ON `messages` (`account_id`,`external_id`);",
      "CREATE INDEX `messages_to_normalize` ON `messages` (`id`) WHERE normalized_text IS NULL AND deleted_at IS NULL;",
      "CREATE INDEX `messages_by_sender_identity_id` ON `messages` (`sender_identity_id`);",
      "CREATE INDEX `messages_by_thread_root_id` ON `messages` (`thread_root_id`);",
      "CREATE INDEX `note_revisions_by_note_id` ON `note_revisions` (`note_id`);",
      "CREATE INDEX `notes_by_notable_type_notable_id` ON `notes` (`notable_type`,`notable_id`);",
      "CREATE INDEX `notes_by_author_type_author_id` ON `notes` (`author_type`,`author_id`);",
      "CREATE INDEX `projects_by_organization_id` ON `projects` (`organization_id`);",
      "CREATE INDEX `projects_by_account_id` ON `projects` (`account_id`);",
      "CREATE INDEX `projects_by_owner_type_owner_id` ON `projects` (`owner_type`,`owner_id`);",
      "CREATE INDEX `proposed_actions_by_status_created_at` ON `proposed_actions` (`status`,`created_at`);",
      "CREATE INDEX `proposed_actions_by_account_id` ON `proposed_actions` (`account_id`);",
      "CREATE INDEX `proposed_actions_by_target_type_target_id` ON `proposed_actions` (`target_type`,`target_id`);",
      "CREATE INDEX `proposed_actions_by_proposed_by_type_proposed_by_id` ON `proposed_actions` (`proposed_by_type`,`proposed_by_id`);",
      "CREATE INDEX `proposed_actions_by_decided_by_type_decided_by_id` ON `proposed_actions` (`decided_by_type`,`decided_by_id`);",
      "CREATE INDEX `reminders_due` ON `reminders` (`account_id`,`state`,`due_at`);",
      "CREATE INDEX `reminders_by_task_id` ON `reminders` (`task_id`);",
      "CREATE UNIQUE INDEX `searches_history` ON `searches` (`command`,`params`) WHERE name IS NULL;",
      "CREATE INDEX `searches_by_last_run` ON `searches` (\"last_run_at\" desc);",
      "CREATE INDEX `syncs_by_account_id` ON `syncs` (`account_id`);",
      "CREATE UNIQUE INDEX `taggings_main_topic` ON `taggings` (`taggable_type`,`taggable_id`) WHERE main = 1;",
      "CREATE INDEX `taggings_by_author_type_author_id` ON `taggings` (`author_type`,`author_id`);",
      "CREATE INDEX `task_assignments_by_assignee_type_assignee_id` ON `task_assignments` (`assignee_type`,`assignee_id`);",
      "CREATE INDEX `task_events_by_task_id` ON `task_events` (`task_id`);",
      "CREATE INDEX `task_events_by_actor_type_actor_id` ON `task_events` (`actor_type`,`actor_id`);",
      "CREATE INDEX `tasks_by_status` ON `tasks` (`project_id`,`status`,`due_at`);",
      "CREATE INDEX `tasks_by_project_id_source_locator` ON `tasks` (`project_id`,`source_locator`);",
      "CREATE INDEX `tasks_by_source_group` ON `tasks` (`source_group`);",
      "CREATE INDEX `tasks_by_parent_id` ON `tasks` (`parent_id`);",
      "CREATE INDEX `tasks_by_closed_by_type_closed_by_id` ON `tasks` (`closed_by_type`,`closed_by_id`);",
      "CREATE INDEX `tasks_by_author_type_author_id` ON `tasks` (`author_type`,`author_id`);",
      "-- Trigram indexes over names and text, kept by triggers; external content, so their rowid is the row's id.\nCREATE VIRTUAL TABLE identities_fts USING fts5(name, username, content='identities', content_rowid='id', tokenize='trigram');",
      "CREATE TRIGGER identities_fts_ai AFTER INSERT ON identities BEGIN\n  INSERT INTO identities_fts (rowid, name, username) VALUES (new.id, new.name, new.username);\nEND;",
      "CREATE TRIGGER identities_fts_au AFTER UPDATE OF name, username ON identities BEGIN\n  INSERT INTO identities_fts (identities_fts, rowid, name, username) VALUES ('delete', old.id, old.name, old.username);\n  INSERT INTO identities_fts (rowid, name, username) VALUES (new.id, new.name, new.username);\nEND;",
      "CREATE TRIGGER identities_fts_ad AFTER DELETE ON identities BEGIN\n  INSERT INTO identities_fts (identities_fts, rowid, name, username) VALUES ('delete', old.id, old.name, old.username);\nEND;",
      "CREATE VIRTUAL TABLE chats_fts USING fts5(title, content='chats', content_rowid='id', tokenize='trigram');",
      "CREATE TRIGGER chats_fts_ai AFTER INSERT ON chats BEGIN\n  INSERT INTO chats_fts (rowid, title) VALUES (new.id, new.title);\nEND;",
      "CREATE TRIGGER chats_fts_au AFTER UPDATE OF title ON chats BEGIN\n  INSERT INTO chats_fts (chats_fts, rowid, title) VALUES ('delete', old.id, old.title);\n  INSERT INTO chats_fts (rowid, title) VALUES (new.id, new.title);\nEND;",
      "CREATE TRIGGER chats_fts_ad AFTER DELETE ON chats BEGIN\n  INSERT INTO chats_fts (chats_fts, rowid, title) VALUES ('delete', old.id, old.title);\nEND;",
      "-- Trigram for message text (owner, 2026-09-29): a search finds any three letters inside a word.\nCREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='id', tokenize='trigram');",
      "CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN\n  INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);\nEND;",
      "CREATE TRIGGER messages_fts_au AFTER UPDATE OF text ON messages BEGIN\n  INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);\n  INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);\nEND;",
      "CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN\n  INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);\nEND;",
      "CREATE TRIGGER chats_count_ai AFTER INSERT ON messages WHEN new.deleted_at IS NULL BEGIN\n  UPDATE chats SET message_count = message_count + 1 WHERE id = new.chat_id;\nEND;",
      "CREATE TRIGGER chats_count_ad AFTER DELETE ON messages WHEN old.deleted_at IS NULL BEGIN\n  UPDATE chats SET message_count = message_count - 1 WHERE id = old.chat_id;\nEND;",
      "CREATE TRIGGER chats_count_tombstone AFTER UPDATE OF deleted_at ON messages\n  WHEN old.deleted_at IS NULL AND new.deleted_at IS NOT NULL BEGIN\n  UPDATE chats SET message_count = message_count - 1 WHERE id = new.chat_id;\nEND;",
      "CREATE TRIGGER chats_count_untombstone AFTER UPDATE OF deleted_at ON messages\n  WHEN old.deleted_at IS NOT NULL AND new.deleted_at IS NULL BEGIN\n  UPDATE chats SET message_count = message_count + 1 WHERE id = new.chat_id;\nEND;",
      "-- Words of the normalized text, ranked by bm25. Contentless with delete support: an index filled in\n-- batches after its triggers exist stays consistent only this way. `scope` holds `c<chat_id>` and\n-- `s<sender_identity_id>` so a small chat or a sender is filtered inside the index.\nCREATE VIRTUAL TABLE message_words USING fts5(\n  normalized_text, scope,\n  content = '', contentless_delete = 1,\n  tokenize = 'unicode61 remove_diacritics 2', prefix = '3');",
      "-- 'col', not 'row': the scope tokens must never come back as a word or a correction.\nCREATE VIRTUAL TABLE message_words_vocab USING fts5vocab(message_words, 'col');",
      "CREATE TRIGGER message_words_ai AFTER INSERT ON messages WHEN new.normalized_text <> '' BEGIN\n  INSERT INTO message_words (rowid, normalized_text, scope)\n    VALUES (new.id, new.normalized_text, 'c' || new.chat_id || coalesce(' s' || new.sender_identity_id, ''));\nEND;",
      "-- Every re-save of a message sets these columns; only a real change may touch the index.\nCREATE TRIGGER message_words_au AFTER UPDATE OF normalized_text, sender_identity_id, chat_id ON messages\n  WHEN old.normalized_text IS NOT new.normalized_text\n    OR old.sender_identity_id IS NOT new.sender_identity_id\n    OR old.chat_id IS NOT new.chat_id BEGIN\n  DELETE FROM message_words WHERE rowid = old.id;\n  INSERT INTO message_words (rowid, normalized_text, scope)\n    SELECT new.id, new.normalized_text, 'c' || new.chat_id || coalesce(' s' || new.sender_identity_id, '')\n    WHERE new.normalized_text <> '';\nEND;",
      "CREATE TRIGGER message_words_ad AFTER DELETE ON messages BEGIN\n  DELETE FROM message_words WHERE rowid = old.id;\nEND;",
      "-- Snowball stems, shaped like `message_words` so its `scope` filter and bm25 weights carry over. No prefix\n-- index: wildcards never read stems. SQL cannot stem, so the triggers only queue the row and JS writes the\n-- stems. Every `*_stems` index below follows this recipe.\nCREATE VIRTUAL TABLE message_stems USING fts5(\n  stems, scope,\n  content = '', contentless_delete = 1,\n  tokenize = 'unicode61 remove_diacritics 2');",
      "CREATE TRIGGER message_stems_ai AFTER INSERT ON messages WHEN new.text <> '' BEGIN\n  INSERT OR IGNORE INTO message_stems_pending (id) VALUES (new.id);\nEND;",
      "CREATE TRIGGER message_stems_au AFTER UPDATE OF text, sender_identity_id, chat_id ON messages\n  WHEN old.text IS NOT new.text\n    OR old.sender_identity_id IS NOT new.sender_identity_id\n    OR old.chat_id IS NOT new.chat_id BEGIN\n  INSERT OR IGNORE INTO message_stems_pending (id) VALUES (new.id);\nEND;",
      "CREATE TRIGGER message_stems_ad AFTER DELETE ON messages BEGIN\n  DELETE FROM message_stems WHERE rowid = old.id;\n  DELETE FROM message_stems_pending WHERE id = old.id;\nEND;",
      "-- Words of an attachment's text, rowid = attachment id. Apart from message_words so `text:` stays what was\n-- written and a file's words never rank a message.\nCREATE VIRTUAL TABLE attachment_words USING fts5(\n  normalized_text,\n  content = '', contentless_delete = 1,\n  tokenize = 'unicode61 remove_diacritics 2');",
      "CREATE TRIGGER attachment_words_ai AFTER INSERT ON attachments WHEN new.normalized_text <> '' BEGIN\n  INSERT INTO attachment_words (rowid, normalized_text) VALUES (new.id, new.normalized_text);\nEND;",
      "CREATE TRIGGER attachment_words_au AFTER UPDATE OF normalized_text ON attachments\n  WHEN old.normalized_text IS NOT new.normalized_text BEGIN\n  DELETE FROM attachment_words WHERE rowid = old.id;\n  INSERT INTO attachment_words (rowid, normalized_text)\n    SELECT new.id, new.normalized_text WHERE new.normalized_text <> '';\nEND;",
      "CREATE TRIGGER attachment_words_ad AFTER DELETE ON attachments BEGIN\n  DELETE FROM attachment_words WHERE rowid = old.id;\nEND;",
      "-- Polymorphic rows have no foreign key to cascade by: these keep what hangs off a message, a chat, an\n-- identity or an account from outliving it, whichever build deletes it.\nCREATE TRIGGER message_tombstone AFTER UPDATE OF deleted_at ON messages\n  WHEN old.deleted_at IS NULL AND new.deleted_at IS NOT NULL BEGIN\n  UPDATE attachments SET text = NULL, normalized_text = NULL\n    WHERE attachable_type = 'message' AND attachable_id = new.id;\n  DELETE FROM taggings WHERE taggable_type = 'message' AND taggable_id = new.id;\nEND;",
      "CREATE TRIGGER message_ad AFTER DELETE ON messages BEGIN\n  DELETE FROM attachments WHERE attachable_type = 'message' AND attachable_id = old.id;\n  DELETE FROM taggings WHERE taggable_type = 'message' AND taggable_id = old.id;\nEND;",
      "CREATE TRIGGER chat_bd BEFORE DELETE ON chats BEGIN\n  DELETE FROM auto_tag_claims WHERE chat_id = old.id;\n  DELETE FROM taggings WHERE taggable_type = 'chat' AND taggable_id = old.id;\n  DELETE FROM aliases WHERE aliasable_type = 'chat' AND aliasable_id = old.id;\nEND;",
      "CREATE TRIGGER identity_bd BEFORE DELETE ON identities BEGIN\n  DELETE FROM aliases WHERE aliasable_type = 'identity' AND aliasable_id = old.id;\nEND;",
      "CREATE TRIGGER account_bd BEFORE DELETE ON accounts BEGIN\n  DELETE FROM aliases WHERE account_id = old.id;\n  DELETE FROM reminders WHERE account_id = old.id;\n  DELETE FROM bot_updates WHERE account_id = old.id;\n  DELETE FROM links WHERE from_type = 'account' AND from_id = old.id;\nEND;",
      "CREATE TRIGGER reminders_task_closed AFTER UPDATE OF status ON tasks\n  WHEN new.status IN ('done', 'dismissed') AND old.status NOT IN ('done', 'dismissed') BEGIN\n  UPDATE reminders SET state = 'cancelled', receipt = NULL, lease_until = NULL, revision = revision + 1\n    WHERE task_id = new.id AND state IN ('pending', 'leased');\nEND;",
      "-- Documents, notes, emails and meetings: written by JS from a queue, not by triggers, because the words are\n-- normalized and the stems computed in JS; every writer only has to enqueue. The words indexes follow\n-- `message_words` (prefix index, a 'col' vocabulary).\nCREATE VIRTUAL TABLE document_words USING fts5(\n  normalized_text, scope,\n  content = '', contentless_delete = 1,\n  tokenize = 'unicode61 remove_diacritics 2', prefix = '3');",
      "CREATE VIRTUAL TABLE document_words_vocab USING fts5vocab(document_words, 'col');",
      "CREATE VIRTUAL TABLE document_stems USING fts5(\n  stems, scope,\n  content = '', contentless_delete = 1,\n  tokenize = 'unicode61 remove_diacritics 2');",
      "CREATE TRIGGER document_index_ai AFTER INSERT ON documents BEGIN\n  INSERT OR IGNORE INTO document_index_pending (indexable_type, id) VALUES ('document', new.id);\nEND;",
      "CREATE TRIGGER document_index_au AFTER UPDATE OF title, body, deleted_at, account_id ON documents\n  WHEN old.title IS NOT new.title OR old.body IS NOT new.body OR old.deleted_at IS NOT new.deleted_at\n    OR old.account_id IS NOT new.account_id BEGIN\n  INSERT OR IGNORE INTO document_index_pending (indexable_type, id) VALUES ('document', new.id);\nEND;",
      "CREATE TRIGGER document_tombstone AFTER UPDATE OF deleted_at ON documents\n  WHEN old.deleted_at IS NULL AND new.deleted_at IS NOT NULL BEGIN\n  DELETE FROM taggings WHERE taggable_type = 'document' AND taggable_id = new.id;\nEND;",
      "-- A vector is keyed by text alone, so it goes only when no other chunk or conversation chunk still uses it.\nCREATE TRIGGER document_bd BEFORE DELETE ON documents BEGIN\n  DELETE FROM embeddings WHERE content_hash IN (\n    SELECT k.content_hash FROM chunks k WHERE k.chunkable_type = 'document' AND k.chunkable_id = old.id\n      AND NOT EXISTS (SELECT 1 FROM chunks o WHERE o.content_hash = k.content_hash\n        AND NOT (o.chunkable_type = 'document' AND o.chunkable_id = old.id)));\n  DELETE FROM chunks WHERE chunkable_type = 'document' AND chunkable_id = old.id;\n  DELETE FROM document_words WHERE rowid = old.id;\n  DELETE FROM document_stems WHERE rowid = old.id;\n  DELETE FROM document_index_pending WHERE indexable_type = 'document' AND id = old.id;\n  DELETE FROM document_revisions WHERE document_id = old.id;\n  DELETE FROM taggings WHERE taggable_type = 'document' AND taggable_id = old.id;\n  DELETE FROM links WHERE from_type = 'document' AND from_id = old.id;\nEND;",
      "CREATE VIRTUAL TABLE note_words USING fts5(\n  normalized_text, scope,\n  content = '', contentless_delete = 1,\n  tokenize = 'unicode61 remove_diacritics 2', prefix = '3');",
      "CREATE VIRTUAL TABLE note_words_vocab USING fts5vocab(note_words, 'col');",
      "CREATE VIRTUAL TABLE note_stems USING fts5(\n  stems, scope,\n  content = '', contentless_delete = 1,\n  tokenize = 'unicode61 remove_diacritics 2');",
      "CREATE TRIGGER note_index_ai AFTER INSERT ON notes BEGIN\n  INSERT OR IGNORE INTO note_index_pending (indexable_type, id) VALUES ('note', new.id);\nEND;",
      "CREATE TRIGGER note_index_au AFTER UPDATE OF title, body, deleted_at, notable_type, notable_id ON notes\n  WHEN old.title IS NOT new.title OR old.body IS NOT new.body OR old.deleted_at IS NOT new.deleted_at\n    OR old.notable_type IS NOT new.notable_type OR old.notable_id IS NOT new.notable_id BEGIN\n  INSERT OR IGNORE INTO note_index_pending (indexable_type, id) VALUES ('note', new.id);\nEND;",
      "CREATE TRIGGER note_tombstone AFTER UPDATE OF deleted_at ON notes\n  WHEN old.deleted_at IS NULL AND new.deleted_at IS NOT NULL BEGIN\n  DELETE FROM taggings WHERE taggable_type = 'note' AND taggable_id = new.id;\nEND;",
      "CREATE TRIGGER note_bd BEFORE DELETE ON notes BEGIN\n  DELETE FROM embeddings WHERE content_hash IN (\n    SELECT k.content_hash FROM chunks k WHERE k.chunkable_type = 'note' AND k.chunkable_id = old.id\n      AND NOT EXISTS (SELECT 1 FROM chunks o WHERE o.content_hash = k.content_hash\n        AND NOT (o.chunkable_type = 'note' AND o.chunkable_id = old.id)));\n  DELETE FROM chunks WHERE chunkable_type = 'note' AND chunkable_id = old.id;\n  DELETE FROM note_words WHERE rowid = old.id;\n  DELETE FROM note_stems WHERE rowid = old.id;\n  DELETE FROM note_index_pending WHERE indexable_type = 'note' AND id = old.id;\n  DELETE FROM note_revisions WHERE note_id = old.id;\n  DELETE FROM taggings WHERE taggable_type = 'note' AND taggable_id = old.id;\n  DELETE FROM links WHERE from_type = 'note' AND from_id = old.id;\nEND;",
      "CREATE VIRTUAL TABLE memory_words USING fts5(\n  normalized_text, scope,\n  content = '', contentless_delete = 1,\n  tokenize = 'unicode61 remove_diacritics 2', prefix = '3');",
      "CREATE VIRTUAL TABLE memory_words_vocab USING fts5vocab(memory_words, 'col');",
      "CREATE VIRTUAL TABLE memory_stems USING fts5(\n  stems, scope,\n  content = '', contentless_delete = 1,\n  tokenize = 'unicode61 remove_diacritics 2');",
      "CREATE TRIGGER memory_index_ai AFTER INSERT ON memories BEGIN\n  INSERT OR IGNORE INTO memory_index_pending (indexable_type, id) VALUES ('memory', new.id);\nEND;",
      "CREATE TRIGGER memory_index_au AFTER UPDATE OF body, status, scope, subject_type, subject_id ON memories\n  WHEN old.body IS NOT new.body OR old.status IS NOT new.status OR old.scope IS NOT new.scope\n    OR old.subject_type IS NOT new.subject_type OR old.subject_id IS NOT new.subject_id BEGIN\n  INSERT OR IGNORE INTO memory_index_pending (indexable_type, id) VALUES ('memory', new.id);\nEND;",
      "-- A memory's evidence is links from it; they go with it, the sources they point at stay.\nCREATE TRIGGER memory_bd BEFORE DELETE ON memories BEGIN\n  DELETE FROM embeddings WHERE content_hash IN (\n    SELECT k.content_hash FROM chunks k WHERE k.chunkable_type = 'memory' AND k.chunkable_id = old.id\n      AND NOT EXISTS (SELECT 1 FROM chunks o WHERE o.content_hash = k.content_hash\n        AND NOT (o.chunkable_type = 'memory' AND o.chunkable_id = old.id)));\n  DELETE FROM chunks WHERE chunkable_type = 'memory' AND chunkable_id = old.id;\n  DELETE FROM memory_words WHERE rowid = old.id;\n  DELETE FROM memory_stems WHERE rowid = old.id;\n  DELETE FROM memory_index_pending WHERE indexable_type = 'memory' AND id = old.id;\n  DELETE FROM taggings WHERE taggable_type = 'memory' AND taggable_id = old.id;\n  DELETE FROM links WHERE from_type = 'memory' AND from_id = old.id;\nEND;",
      "CREATE VIRTUAL TABLE email_words USING fts5(\n  normalized_text, scope,\n  content = '', contentless_delete = 1,\n  tokenize = 'unicode61 remove_diacritics 2', prefix = '3');",
      "CREATE VIRTUAL TABLE email_words_vocab USING fts5vocab(email_words, 'col');",
      "CREATE VIRTUAL TABLE email_stems USING fts5(\n  stems, scope,\n  content = '', contentless_delete = 1,\n  tokenize = 'unicode61 remove_diacritics 2');",
      "CREATE TRIGGER email_index_ai AFTER INSERT ON emails BEGIN\n  INSERT OR IGNORE INTO email_index_pending (indexable_type, id) VALUES ('email', new.id);\nEND;",
      "CREATE TRIGGER email_index_au AFTER UPDATE OF subject, body_text, deleted_at, email_thread_id ON emails\n  WHEN old.subject IS NOT new.subject OR old.body_text IS NOT new.body_text\n    OR old.deleted_at IS NOT new.deleted_at OR old.email_thread_id IS NOT new.email_thread_id BEGIN\n  INSERT OR IGNORE INTO email_index_pending (indexable_type, id) VALUES ('email', new.id);\nEND;",
      "CREATE TRIGGER email_bd BEFORE DELETE ON emails BEGIN\n  DELETE FROM embeddings WHERE content_hash IN (\n    SELECT k.content_hash FROM chunks k WHERE k.chunkable_type = 'email' AND k.chunkable_id = old.id\n      AND NOT EXISTS (SELECT 1 FROM chunks o WHERE o.content_hash = k.content_hash\n        AND NOT (o.chunkable_type = 'email' AND o.chunkable_id = old.id)));\n  DELETE FROM chunks WHERE chunkable_type = 'email' AND chunkable_id = old.id;\n  DELETE FROM email_recipients WHERE email_id = old.id;\n  DELETE FROM email_mailboxes WHERE email_id = old.id;\n  DELETE FROM email_words WHERE rowid = old.id;\n  DELETE FROM email_stems WHERE rowid = old.id;\n  DELETE FROM email_index_pending WHERE indexable_type = 'email' AND id = old.id;\n  DELETE FROM attachments WHERE attachable_type = 'email' AND attachable_id = old.id;\n  DELETE FROM taggings WHERE taggable_type = 'email' AND taggable_id = old.id;\nEND;",
      "-- Three tables feed the meeting index and their ids overlap, so the rowid scheme is the indexer's: a change\n-- or a delete only queues the row, and the drain removes what it finds gone.\nCREATE VIRTUAL TABLE meeting_words USING fts5(\n  normalized_text, scope,\n  content = '', contentless_delete = 1,\n  tokenize = 'unicode61 remove_diacritics 2', prefix = '3');",
      "CREATE VIRTUAL TABLE meeting_words_vocab USING fts5vocab(meeting_words, 'col');",
      "CREATE VIRTUAL TABLE meeting_stems USING fts5(\n  stems, scope,\n  content = '', contentless_delete = 1,\n  tokenize = 'unicode61 remove_diacritics 2');",
      "CREATE TRIGGER meeting_transcript_row_index_ai AFTER INSERT ON meeting_transcript_rows BEGIN\n  INSERT OR IGNORE INTO meeting_index_pending (indexable_type, id) VALUES ('meeting_transcript_row', new.id);\nEND;",
      "CREATE TRIGGER meeting_transcript_row_index_au AFTER UPDATE OF text ON meeting_transcript_rows\n  WHEN old.text IS NOT new.text BEGIN\n  INSERT OR IGNORE INTO meeting_index_pending (indexable_type, id) VALUES ('meeting_transcript_row', new.id);\nEND;",
      "CREATE TRIGGER meeting_transcript_row_index_ad AFTER DELETE ON meeting_transcript_rows BEGIN\n  INSERT OR IGNORE INTO meeting_index_pending (indexable_type, id) VALUES ('meeting_transcript_row', old.id);\nEND;",
      "CREATE TRIGGER meeting_chat_message_index_ai AFTER INSERT ON meeting_chat_messages BEGIN\n  INSERT OR IGNORE INTO meeting_index_pending (indexable_type, id) VALUES ('meeting_chat_message', new.id);\nEND;",
      "CREATE TRIGGER meeting_chat_message_index_au AFTER UPDATE OF text ON meeting_chat_messages\n  WHEN old.text IS NOT new.text BEGIN\n  INSERT OR IGNORE INTO meeting_index_pending (indexable_type, id) VALUES ('meeting_chat_message', new.id);\nEND;",
      "CREATE TRIGGER meeting_chat_message_index_ad AFTER DELETE ON meeting_chat_messages BEGIN\n  INSERT OR IGNORE INTO meeting_index_pending (indexable_type, id) VALUES ('meeting_chat_message', old.id);\nEND;",
      "CREATE TRIGGER meeting_summary_index_ai AFTER INSERT ON meeting_summaries BEGIN\n  INSERT OR IGNORE INTO meeting_index_pending (indexable_type, id) VALUES ('meeting_summary', new.id);\nEND;",
      "CREATE TRIGGER meeting_summary_index_au AFTER UPDATE OF title, overview, sections, next_steps, content ON meeting_summaries\n  WHEN old.title IS NOT new.title OR old.overview IS NOT new.overview OR old.sections IS NOT new.sections\n    OR old.next_steps IS NOT new.next_steps OR old.content IS NOT new.content BEGIN\n  INSERT OR IGNORE INTO meeting_index_pending (indexable_type, id) VALUES ('meeting_summary', new.id);\nEND;",
      "CREATE TRIGGER meeting_summary_index_ad AFTER DELETE ON meeting_summaries BEGIN\n  INSERT OR IGNORE INTO meeting_index_pending (indexable_type, id) VALUES ('meeting_summary', old.id);\nEND;",
      "-- Drizzle cannot declare WITHOUT ROWID, so the vocabulary is written here and not in schema.ts.\nCREATE TABLE search_terms (\n  term   TEXT PRIMARY KEY,\n  length INTEGER NOT NULL\n) WITHOUT ROWID;",
      "CREATE TABLE search_term_trigrams (\n  trigram TEXT NOT NULL,\n  length  INTEGER NOT NULL,\n  term    TEXT NOT NULL,\n  PRIMARY KEY (trigram, length, term)\n) WITHOUT ROWID;",
      "-- Who took part in what. A change only queues the thing it touches; the drain recomputes that thing's rows,\n-- so no write parses `mentions` and no sync rebuilds the whole index. A person relinked keeps their rows.\nCREATE TRIGGER involvement_message_ai AFTER INSERT ON messages BEGIN\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('message', new.id);\nEND;",
      "CREATE TRIGGER involvement_message_au AFTER UPDATE OF sender_identity_id, mentions, deleted_at, sent_at, chat_id ON messages\n  WHEN old.sender_identity_id IS NOT new.sender_identity_id OR old.mentions IS NOT new.mentions\n    OR old.deleted_at IS NOT new.deleted_at OR old.sent_at IS NOT new.sent_at OR old.chat_id IS NOT new.chat_id BEGIN\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('message', new.id);\nEND;",
      "CREATE TRIGGER involvement_message_ad AFTER DELETE ON messages BEGIN\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('message', old.id);\nEND;",
      "CREATE TRIGGER involvement_chat_member_ai AFTER INSERT ON chat_members BEGIN\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('chat', new.chat_id);\nEND;",
      "CREATE TRIGGER involvement_chat_member_ad AFTER DELETE ON chat_members BEGIN\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('chat', old.chat_id);\nEND;",
      "CREATE TRIGGER involvement_chat_scope AFTER UPDATE OF scope ON chats WHEN old.scope IS NOT new.scope BEGIN\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('chat', new.id);\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT 'message', id FROM messages WHERE chat_id = new.id;\nEND;",
      "CREATE TRIGGER involvement_account_scope AFTER UPDATE OF scope ON accounts WHEN old.scope IS NOT new.scope BEGIN\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT 'chat', id FROM chats WHERE account_id = new.id;\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT 'message', id FROM messages WHERE account_id = new.id;\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT 'meeting', id FROM meetings WHERE account_id = new.id;\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT 'email', id FROM emails WHERE account_id = new.id;\nEND;",
      "CREATE TRIGGER involvement_meeting_au AFTER UPDATE OF deleted_at, started_at ON meetings\n  WHEN old.deleted_at IS NOT new.deleted_at OR old.started_at IS NOT new.started_at BEGIN\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('meeting', new.id);\nEND;",
      "CREATE TRIGGER involvement_meeting_ad AFTER DELETE ON meetings BEGIN\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('meeting', old.id);\nEND;",
      "CREATE TRIGGER involvement_meeting_participant_ai AFTER INSERT ON meeting_participants BEGIN\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('meeting', new.meeting_id);\nEND;",
      "CREATE TRIGGER involvement_meeting_participant_au AFTER UPDATE OF identity_id ON meeting_participants WHEN old.identity_id IS NOT new.identity_id BEGIN\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('meeting', new.meeting_id);\nEND;",
      "CREATE TRIGGER involvement_meeting_participant_ad AFTER DELETE ON meeting_participants BEGIN\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('meeting', old.meeting_id);\nEND;",
      "CREATE TRIGGER involvement_email_ai AFTER INSERT ON emails BEGIN\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('email', new.id);\nEND;",
      "CREATE TRIGGER involvement_email_au AFTER UPDATE OF from_identity_id, deleted_at, sent_at, received_at ON emails\n  WHEN old.from_identity_id IS NOT new.from_identity_id OR old.deleted_at IS NOT new.deleted_at\n    OR old.sent_at IS NOT new.sent_at OR old.received_at IS NOT new.received_at BEGIN\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('email', new.id);\nEND;",
      "CREATE TRIGGER involvement_email_ad AFTER DELETE ON emails BEGIN\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('email', old.id);\nEND;",
      "CREATE TRIGGER involvement_email_recipient_ai AFTER INSERT ON email_recipients BEGIN\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('email', new.email_id);\nEND;",
      "CREATE TRIGGER involvement_email_recipient_ad AFTER DELETE ON email_recipients BEGIN\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('email', old.email_id);\nEND;",
      "CREATE TRIGGER involvement_task_ai AFTER INSERT ON tasks BEGIN\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('task', new.id);\nEND;",
      "CREATE TRIGGER involvement_task_au AFTER UPDATE OF author_type, author_id, deleted_at, project_id ON tasks\n  WHEN old.author_type IS NOT new.author_type OR old.author_id IS NOT new.author_id\n    OR old.deleted_at IS NOT new.deleted_at OR old.project_id IS NOT new.project_id BEGIN\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('task', new.id);\nEND;",
      "CREATE TRIGGER involvement_task_ad AFTER DELETE ON tasks BEGIN\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('task', old.id);\nEND;",
      "CREATE TRIGGER involvement_task_assignment_ai AFTER INSERT ON task_assignments BEGIN\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('task', new.task_id);\nEND;",
      "CREATE TRIGGER involvement_task_assignment_ad AFTER DELETE ON task_assignments BEGIN\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('task', old.task_id);\nEND;",
      "CREATE TRIGGER involvement_project_scope AFTER UPDATE OF scope ON projects WHEN old.scope IS NOT new.scope BEGIN\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('project', new.id);\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT 'task', id FROM tasks WHERE project_id = new.id;\nEND;",
      "CREATE TRIGGER involvement_document_au AFTER UPDATE OF deleted_at ON documents WHEN old.deleted_at IS NOT new.deleted_at BEGIN\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('document', new.id);\nEND;",
      "CREATE TRIGGER involvement_document_ad AFTER DELETE ON documents BEGIN\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES ('document', old.id);\nEND;",
      "CREATE TRIGGER involvement_link_ai AFTER INSERT ON links BEGIN\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES (new.from_type, new.from_id);\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT new.to_type, new.to_id\n    WHERE new.from_type IN ('person', 'identity') AND new.to_id IS NOT NULL;\nEND;",
      "CREATE TRIGGER involvement_link_au AFTER UPDATE ON links BEGIN\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES (old.from_type, old.from_id);\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT old.to_type, old.to_id\n    WHERE old.from_type IN ('person', 'identity') AND old.to_id IS NOT NULL;\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES (new.from_type, new.from_id);\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT new.to_type, new.to_id\n    WHERE new.from_type IN ('person', 'identity') AND new.to_id IS NOT NULL;\nEND;",
      "CREATE TRIGGER involvement_link_ad AFTER DELETE ON links BEGIN\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) VALUES (old.from_type, old.from_id);\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT old.to_type, old.to_id\n    WHERE old.from_type IN ('person', 'identity') AND old.to_id IS NOT NULL;\nEND;",
      "-- One identity links to one person, so a relink moves its rows and an unlink drops them. A new link queues\n-- what the identity already took part in; a mention of it in an older message waits for `store reindex`.\nCREATE TRIGGER involvement_identity_link_ai AFTER INSERT ON identity_links BEGIN\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT 'message', id FROM messages WHERE sender_identity_id = new.identity_id;\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT 'chat', chat_id FROM chat_members WHERE identity_id = new.identity_id;\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT 'meeting', meeting_id FROM meeting_participants WHERE identity_id = new.identity_id;\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT 'email', id FROM emails WHERE from_identity_id = new.identity_id;\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT 'email', email_id FROM email_recipients WHERE identity_id = new.identity_id;\n  INSERT OR IGNORE INTO involvement_pending (indexable_type, id) SELECT from_type, from_id FROM links WHERE to_type = 'identity' AND to_id = new.identity_id;\nEND;",
      "CREATE TRIGGER involvement_identity_link_au AFTER UPDATE OF person_id ON identity_links WHEN old.person_id IS NOT new.person_id BEGIN\n  UPDATE involvements SET person_id = new.person_id WHERE identity_id = new.identity_id;\nEND;",
      "CREATE TRIGGER involvement_identity_link_ad AFTER DELETE ON identity_links BEGIN\n  DELETE FROM involvements WHERE identity_id = old.identity_id;\nEND;",
      "-- A conversation's chunk is a `chunks` row whose message range is in `chunk_messages`: deleting a message\n-- cascades to the range, and the range takes its chunk with it, as a conversation takes all of its chunks.\nCREATE TRIGGER chunk_messages_ad AFTER DELETE ON chunk_messages BEGIN\n  DELETE FROM chunks WHERE id = old.chunk_id;\nEND;",
      "CREATE TRIGGER conversation_ad AFTER DELETE ON conversations BEGIN\n  DELETE FROM chunks WHERE chunkable_type = 'conversation' AND chunkable_id = old.id;\nEND;",
      "-- A conversation chunk copies its chat's scope and project so a search filters before it compares; these keep\n-- the copies right when the chat, its account or its project link changes.\nCREATE TRIGGER conversation_chunks_chat_scope AFTER UPDATE OF scope ON chats WHEN old.scope IS NOT new.scope BEGIN\n  UPDATE chunks SET scope = coalesce(new.scope, (SELECT scope FROM accounts WHERE id = new.account_id))\n    WHERE chunkable_type = 'conversation' AND chunkable_id IN (SELECT id FROM conversations WHERE chat_id = new.id);\nEND;",
      "CREATE TRIGGER conversation_chunks_account_scope AFTER UPDATE OF scope ON accounts WHEN old.scope IS NOT new.scope BEGIN\n  UPDATE chunks SET scope = new.scope\n    WHERE chunkable_type = 'conversation' AND chunkable_id IN (\n      SELECT c.id FROM conversations c JOIN chats ch ON ch.id = c.chat_id WHERE ch.account_id = new.id AND ch.scope IS NULL);\nEND;",
      "CREATE TRIGGER conversation_chunks_project_ai AFTER INSERT ON links\n  WHEN new.from_type = 'chat' AND new.to_type = 'project' AND new.kind = 'member-of' BEGIN\n  UPDATE chunks SET project_id = (SELECT to_id FROM links WHERE from_type = 'chat' AND from_id = new.from_id\n      AND to_type = 'project' AND kind = 'member-of' AND confirmed = 1 ORDER BY id LIMIT 1)\n    WHERE chunkable_type = 'conversation' AND chunkable_id IN (SELECT id FROM conversations WHERE chat_id = new.from_id);\nEND;",
      "CREATE TRIGGER conversation_chunks_project_au AFTER UPDATE ON links\n  WHEN new.from_type = 'chat' AND new.to_type = 'project' AND new.kind = 'member-of' BEGIN\n  UPDATE chunks SET project_id = (SELECT to_id FROM links WHERE from_type = 'chat' AND from_id = new.from_id\n      AND to_type = 'project' AND kind = 'member-of' AND confirmed = 1 ORDER BY id LIMIT 1)\n    WHERE chunkable_type = 'conversation' AND chunkable_id IN (SELECT id FROM conversations WHERE chat_id = new.from_id);\nEND;",
      "CREATE TRIGGER conversation_chunks_project_ad AFTER DELETE ON links\n  WHEN old.from_type = 'chat' AND old.to_type = 'project' AND old.kind = 'member-of' BEGIN\n  UPDATE chunks SET project_id = (SELECT to_id FROM links WHERE from_type = 'chat' AND from_id = old.from_id\n      AND to_type = 'project' AND kind = 'member-of' AND confirmed = 1 ORDER BY id LIMIT 1)\n    WHERE chunkable_type = 'conversation' AND chunkable_id IN (SELECT id FROM conversations WHERE chat_id = old.from_id);\nEND;",
      "-- A new file has nothing to fill: the words index is built at once. `analyzer` stays NULL until the first\n-- drain claims it.\nINSERT INTO search_index_state (name, watermark, filled_through, terms_through, normalizer_version, built_at, analyzer)\n  VALUES ('message_words', 0, 0, 0, 1, CAST(unixepoch('subsec') * 1000 AS INTEGER), NULL),\n         ('message_stems', 0, 0, 0, 1, NULL, NULL),\n         ('note_index', 0, 0, 0, 1, NULL, NULL),\n         ('document_index', 0, 0, 0, 1, NULL, NULL),\n         ('memory_index', 0, 0, 0, 1, NULL, NULL);",
      "-- The actors a task names before any messenger has saved anyone: the owner, and the bots a rule and an\n-- unnamed agent act as. A note about nothing in particular is about this owner row.\nINSERT INTO persons (name, owner, created_at, updated_at)\n  VALUES (NULL, 1, CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER));",
      "INSERT INTO bots (name, kind, created_at, updated_at)\n  VALUES ('rule', 'script', CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER)),\n         ('agent', 'agent', CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER));"
    ]
  },
  {
    "name": "20261011035353_version-2-facts",
    "statements": [
      "CREATE TABLE `facts` (\n\t`id` integer PRIMARY KEY,\n\t`type` text NOT NULL,\n\t`statement` text NOT NULL,\n\t`status` text NOT NULL,\n\t`project_id` integer,\n\t`subject_type` text,\n\t`subject_id` integer,\n\t`occurred_at` integer,\n\t`supersedes_id` integer,\n\t`author_type` text NOT NULL,\n\t`author_id` integer NOT NULL,\n\t`model` text,\n\t`confirmed_by_type` text,\n\t`confirmed_by_id` integer,\n\t`scope` text,\n\t`source` text NOT NULL,\n\t`metadata` text,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\tCONSTRAINT `fk_facts_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),\n\tCONSTRAINT `fk_facts_supersedes_id_facts_id_fk` FOREIGN KEY (`supersedes_id`) REFERENCES `facts`(`id`)\n);",
      "ALTER TABLE `memories` ADD `deleted_at` integer;",
      "CREATE INDEX `facts_by_project_id` ON `facts` (`project_id`);",
      "CREATE INDEX `facts_by_subject_type_subject_id` ON `facts` (`subject_type`,`subject_id`);",
      "CREATE INDEX `facts_by_supersedes_id` ON `facts` (`supersedes_id`);",
      "CREATE INDEX `facts_by_author_type_author_id` ON `facts` (`author_type`,`author_id`);",
      "CREATE INDEX `facts_by_confirmed_by_type_confirmed_by_id` ON `facts` (`confirmed_by_type`,`confirmed_by_id`);"
    ]
  },
  {
    "name": "20261011035430_version-2-facts-from-memories",
    "statements": [
      "-- A memory of kind `fact` becomes a fact: what happened is a fact, not a conclusion. Its id rides in\n-- `metadata.memory` so its links can follow; the memory row stays, marked deleted.\nINSERT INTO facts (type, statement, status, subject_type, subject_id, author_type, author_id, model,\n  confirmed_by_type, confirmed_by_id, scope, source, metadata, created_at, updated_at, deleted_at)\nSELECT 'fact', m.body,\n  CASE m.status WHEN 'proposed' THEN 'proposed' WHEN 'stale' THEN 'proposed' ELSE 'accepted' END,\n  m.subject_type, m.subject_id, m.author_type, m.author_id, m.model,\n  CASE m.status WHEN 'confirmed' THEN 'person' END,\n  CASE m.status WHEN 'confirmed' THEN (SELECT id FROM persons WHERE owner = 1 ORDER BY id LIMIT 1) END,\n  m.scope, 'memory',\n  json_object('memory', m.id, 'memory_status', m.status, 'confidence', m.confidence,\n    'last_verified_at', m.last_verified_at),\n  m.created_at, m.updated_at,\n  CASE m.status WHEN 'superseded' THEN m.updated_at END\nFROM memories m WHERE m.kind = 'fact' AND m.deleted_at IS NULL ORDER BY m.id;",
      "UPDATE links SET from_type = 'fact', from_id = (\n  SELECT f.id FROM facts f WHERE f.source = 'memory' AND json_extract(f.metadata, '$.memory') = links.from_id)\nWHERE from_type = 'memory' AND from_id IN (SELECT id FROM memories WHERE kind = 'fact' AND deleted_at IS NULL);",
      "UPDATE links SET to_type = 'fact', to_id = (\n  SELECT f.id FROM facts f WHERE f.source = 'memory' AND json_extract(f.metadata, '$.memory') = links.to_id)\nWHERE to_type = 'memory' AND to_id IN (SELECT id FROM memories WHERE kind = 'fact' AND deleted_at IS NULL);",
      "UPDATE notes SET notable_type = 'fact', notable_id = (\n  SELECT f.id FROM facts f WHERE f.source = 'memory' AND json_extract(f.metadata, '$.memory') = notes.notable_id)\nWHERE notable_type = 'memory' AND notable_id IN (SELECT id FROM memories WHERE kind = 'fact' AND deleted_at IS NULL);",
      "UPDATE taggings SET taggable_type = 'fact', taggable_id = (\n  SELECT f.id FROM facts f WHERE f.source = 'memory' AND json_extract(f.metadata, '$.memory') = taggings.taggable_id)\nWHERE taggable_type = 'memory' AND taggable_id IN (SELECT id FROM memories WHERE kind = 'fact' AND deleted_at IS NULL);",
      "UPDATE memories SET deleted_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000\nWHERE kind = 'fact' AND deleted_at IS NULL;",
      "-- An assignment's one home is task_assignments; the assigned-to links stay until their readers move.\nINSERT OR IGNORE INTO task_assignments (task_id, assignee_type, assignee_id, role, created_at, updated_at)\nSELECT l.from_id, 'person', l.to_id, 'assignee', l.created_at, l.updated_at FROM links l\nWHERE l.kind = 'assigned-to' AND l.confirmed = 1 AND l.from_type = 'task' AND l.to_type = 'person'\n  AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = l.from_id) AND EXISTS (SELECT 1 FROM persons p WHERE p.id = l.to_id)\nORDER BY l.id;"
    ]
  },
  {
    "name": "20261011115708_version-3-vocabulary",
    "statements": [
      "CREATE UNIQUE INDEX `aliases_by_aliasable_type_aliasable_id_name_folded` ON `aliases` (`aliasable_type`,`aliasable_id`,`name_folded`) WHERE account_id IS NULL AND aliasable_type = 'project' OR account_id IS NULL AND aliasable_type = 'tag';"
    ]
  },
  {
    "name": "20261011172120_version-4-task-next-check",
    "statements": [
      "ALTER TABLE `tasks` ADD `next_check_at` integer;",
      "CREATE INDEX `tasks_by_project_id_status_next_check_at` ON `tasks` (`project_id`,`status`,`next_check_at`);"
    ]
  },
  {
    "name": "20261013090001_version-5-file-name-words",
    "statements": [
      "-- Words of an attachment's file name, rowid = attachment id, so a bare search word finds a file by its name\n-- without reading every name. unicode61 folds case and Latin accents but not й and ё, which normalize()\n-- folds into и and е: the triggers fold those two so a query normalized in JS still matches.\nCREATE VIRTUAL TABLE attachment_name_words USING fts5(\n  name,\n  content = '', contentless_delete = 1,\n  tokenize = 'unicode61 remove_diacritics 2');",
      "CREATE TRIGGER attachment_name_words_ai AFTER INSERT ON attachments WHEN new.name IS NOT NULL BEGIN\n  INSERT INTO attachment_name_words (rowid, name)\n    VALUES (new.id, replace(replace(replace(replace(new.name, 'й', 'и'), 'Й', 'И'), 'ё', 'е'), 'Ё', 'Е'));\nEND;",
      "CREATE TRIGGER attachment_name_words_au AFTER UPDATE OF name ON attachments\n  WHEN old.name IS NOT new.name BEGIN\n  DELETE FROM attachment_name_words WHERE rowid = old.id;\n  INSERT INTO attachment_name_words (rowid, name)\n    SELECT new.id, replace(replace(replace(replace(new.name, 'й', 'и'), 'Й', 'И'), 'ё', 'е'), 'Ё', 'Е')\n    WHERE new.name IS NOT NULL;\nEND;",
      "CREATE TRIGGER attachment_name_words_ad AFTER DELETE ON attachments BEGIN\n  DELETE FROM attachment_name_words WHERE rowid = old.id;\nEND;",
      "INSERT INTO attachment_name_words (rowid, name)\n  SELECT id, replace(replace(replace(replace(name, 'й', 'и'), 'Й', 'И'), 'ё', 'е'), 'Ё', 'Е')\n  FROM attachments WHERE name IS NOT NULL;"
    ]
  },
  {
    "name": "20261013201057_version-6-query-tree-keys",
    "statements": [
      "-- A query tree kept in a search — `params.ast` and a ranking's `params.selection` — takes cli-base 0.26's keys:\n-- `lower_inclusive`, `upper_inclusive` and the occur `must_not`. A text replace keeps every key in place, so\n-- `params` stays the canonical text that history matches on; inside a JSON string these quotes are escaped, so a\n-- message's words never match.\nUPDATE searches SET params = json_set(params, '$.ast', json(\n  replace(replace(replace(json_extract(params, '$.ast'),\n    '\"lowerInclusive\":', '\"lower_inclusive\":'),\n    '\"upperInclusive\":', '\"upper_inclusive\":'),\n    '\"occur\":\"mustNot\"', '\"occur\":\"must_not\"')))\nWHERE json_type(params, '$.ast') = 'object';",
      "UPDATE searches SET params = json_set(params, '$.selection', json(\n  replace(replace(replace(json_extract(params, '$.selection'),\n    '\"lowerInclusive\":', '\"lower_inclusive\":'),\n    '\"upperInclusive\":', '\"upper_inclusive\":'),\n    '\"occur\":\"mustNot\"', '\"occur\":\"must_not\"')))\nWHERE json_type(params, '$.selection') = 'object';"
    ]
  },
  {
    "name": "20261013215247_version-7-mentions",
    "statements": [
      "CREATE TABLE `mention_pending` (\n\t`source_type` text NOT NULL,\n\t`source_id` integer NOT NULL,\n\tCONSTRAINT `mention_pending_pk` PRIMARY KEY(`source_type`, `source_id`)\n);",
      "CREATE TABLE `mentions` (\n\t`id` integer PRIMARY KEY,\n\t`kind` text NOT NULL,\n\t`source_type` text NOT NULL,\n\t`source_id` integer NOT NULL,\n\t`source_field` text NOT NULL,\n\t`start_offset` integer NOT NULL,\n\t`end_offset` integer NOT NULL,\n\t`value` text NOT NULL,\n\t`domain` text,\n\t`method` text NOT NULL,\n\t`version` integer NOT NULL,\n\t`confidence` real NOT NULL,\n\t`status` text NOT NULL,\n\t`target_type` text,\n\t`target_id` integer,\n\t`author` text,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `mentions_source_type_source_id_source_field_start_offset_kind_unique` UNIQUE(`source_type`,`source_id`,`source_field`,`start_offset`,`kind`)\n);",
      "CREATE INDEX `mentions_by_kind_value` ON `mentions` (`kind`,`value`);",
      "CREATE INDEX `mentions_by_domain` ON `mentions` (`domain`) WHERE domain IS NOT NULL;",
      "CREATE INDEX `mentions_by_status_kind` ON `mentions` (`status`,`kind`);",
      "CREATE INDEX `mentions_by_target_type_target_id` ON `mentions` (`target_type`,`target_id`) WHERE target_id IS NOT NULL;"
    ]
  },
  {
    "name": "20261013215251_version-7-mentions-triggers",
    "statements": [
      "-- Finding mentions needs JS, so the triggers only queue the message and the store's next write finds them.\n-- Messages stored before version 7 are not queued here: `mentions rebuild` reads them in batches.\nCREATE TRIGGER mention_pending_message_ai AFTER INSERT ON messages WHEN new.text <> '' BEGIN\n  INSERT OR IGNORE INTO mention_pending (source_type, source_id) VALUES ('message', new.id);\nEND;",
      "CREATE TRIGGER mention_pending_message_au AFTER UPDATE OF text ON messages WHEN old.text IS NOT new.text BEGIN\n  INSERT OR IGNORE INTO mention_pending (source_type, source_id) VALUES ('message', new.id);\nEND;",
      "CREATE TRIGGER mentions_message_ad AFTER DELETE ON messages BEGIN\n  DELETE FROM mentions WHERE source_type = 'message' AND source_id = old.id;\n  DELETE FROM mention_pending WHERE source_type = 'message' AND source_id = old.id;\nEND;"
    ]
  },
  {
    "name": "20261014100438_version-8-folded-names",
    "statements": [
      "ALTER TABLE `attachments` ADD `name_folded` text;",
      "ALTER TABLE `attachments` ADD `local_path_folded` text;",
      "ALTER TABLE `meetings` ADD `title_folded` text;",
      "ALTER TABLE `tasks` ADD `title_folded` text;",
      "ALTER TABLE `tasks` ADD `close_reason_folded` text;",
      "CREATE INDEX `attachments_by_name_folded` ON `attachments` (`name_folded`);",
      "CREATE INDEX `meetings_by_account_id_title_folded` ON `meetings` (`account_id`,`title_folded`);",
      "CREATE INDEX `tasks_by_title_folded` ON `tasks` (`title_folded`);"
    ]
  },
  {
    "name": "20261014105203_version-9-folded-fill",
    "statements": [
      "CREATE INDEX `attachments_local_path_to_fold` ON `attachments` (`id`) WHERE local_path IS NOT NULL AND local_path_folded IS NULL;",
      "CREATE INDEX `meetings_title_to_fold` ON `meetings` (`id`) WHERE title IS NOT NULL AND title_folded IS NULL;",
      "CREATE INDEX `tasks_close_reason_to_fold` ON `tasks` (`id`) WHERE close_reason IS NOT NULL AND close_reason_folded IS NULL;"
    ]
  },
  {
    "name": "20261014123446_version-10-mentions-in-attachments",
    "statements": [
      "-- A message's files and voice notes have text of their own (attachments.text): queue it for mentions as a\n-- message's text is, and drop its mentions with it. Attachments stored before version 10 wait for\n-- `mentions rebuild`, as messages stored before version 7 do.\nCREATE TRIGGER mention_pending_attachment_ai AFTER INSERT ON attachments\n  WHEN new.attachable_type = 'message' AND coalesce(new.text, '') <> '' BEGIN\n  INSERT OR IGNORE INTO mention_pending (source_type, source_id) VALUES ('attachment', new.id);\nEND;",
      "CREATE TRIGGER mention_pending_attachment_au AFTER UPDATE OF text, extractor ON attachments\n  WHEN new.attachable_type = 'message' AND (old.text IS NOT new.text OR old.extractor IS NOT new.extractor) BEGIN\n  INSERT OR IGNORE INTO mention_pending (source_type, source_id) VALUES ('attachment', new.id);\nEND;",
      "CREATE TRIGGER mentions_attachment_ad AFTER DELETE ON attachments BEGIN\n  DELETE FROM mentions WHERE source_type = 'attachment' AND source_id = old.id;\n  DELETE FROM mention_pending WHERE source_type = 'attachment' AND source_id = old.id;\nEND;"
    ]
  },
  {
    "name": "20261014125554_version-11-organization-identities",
    "statements": [
      "CREATE TABLE `organization_identities` (\n\t`id` integer PRIMARY KEY,\n\t`identity_id` integer NOT NULL,\n\t`organization_id` integer NOT NULL,\n\t`method` text NOT NULL,\n\t`author` text NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `fk_organization_identities_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`),\n\tCONSTRAINT `fk_organization_identities_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`),\n\tCONSTRAINT `organization_identities_identity_id_organization_id_unique` UNIQUE(`identity_id`,`organization_id`)\n);",
      "CREATE INDEX `organization_identities_by_organization_id` ON `organization_identities` (`organization_id`);"
    ]
  },
  {
    "name": "20261014195259_version-12-mail-rules",
    "statements": [
      "CREATE TABLE `mail_rules` (\n\t`id` integer PRIMARY KEY,\n\t`account_id` integer NOT NULL,\n\t`conditions` text NOT NULL,\n\t`actions` text NOT NULL,\n\t`protected` integer DEFAULT 0 NOT NULL,\n\t`source` text NOT NULL,\n\t`reason` text,\n\t`decided_at` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `fk_mail_rules_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),\n\tCONSTRAINT `mail_rules_account_id_conditions_unique` UNIQUE(`account_id`,`conditions`)\n);",
      "ALTER TABLE `emails` ADD `mail_rule_id` integer;",
      "CREATE INDEX `emails_by_mail_rule_id` ON `emails` (`mail_rule_id`) WHERE mail_rule_id IS NOT NULL;"
    ]
  },
  {
    "name": "20261014204055_version-13-task-fields",
    "statements": [
      "CREATE TABLE `task_key_counters` (\n\t`prefix` text PRIMARY KEY,\n\t`tasks_count` integer NOT NULL\n);",
      "ALTER TABLE `tasks` ADD `category` text;",
      "ALTER TABLE `tasks` ADD `claimed_by` text;",
      "ALTER TABLE `tasks` ADD `claimed_until` integer;"
    ]
  },
  {
    "name": "20261014222837_version-14-task-words",
    "statements": [
      "CREATE TABLE `task_index_pending` (\n\t`id` integer NOT NULL,\n\t`indexable_type` text NOT NULL,\n\tCONSTRAINT `task_index_pending_pk` PRIMARY KEY(`indexable_type`, `id`)\n);"
    ]
  },
  {
    "name": "20261014222841_version-14-task-words-triggers",
    "statements": [
      "-- Words and stems of a task's title and description, rowid = task id, for the duplicate check's candidate lookup.\n-- Stemming needs JS, so the triggers only queue the task and the next lookup indexes it, as notes do.\nCREATE VIRTUAL TABLE task_words USING fts5(\n  normalized_text, scope,\n  content = '', contentless_delete = 1,\n  tokenize = 'unicode61 remove_diacritics 2', prefix = '3');",
      "CREATE VIRTUAL TABLE task_words_vocab USING fts5vocab(task_words, 'col');",
      "CREATE VIRTUAL TABLE task_stems USING fts5(\n  stems, scope,\n  content = '', contentless_delete = 1,\n  tokenize = 'unicode61 remove_diacritics 2');",
      "CREATE TRIGGER task_index_ai AFTER INSERT ON tasks BEGIN\n  INSERT OR IGNORE INTO task_index_pending (indexable_type, id) VALUES ('task', new.id);\nEND;",
      "CREATE TRIGGER task_index_au AFTER UPDATE OF title, description, deleted_at ON tasks\n  WHEN old.title IS NOT new.title OR old.description IS NOT new.description OR old.deleted_at IS NOT new.deleted_at BEGIN\n  INSERT OR IGNORE INTO task_index_pending (indexable_type, id) VALUES ('task', new.id);\nEND;",
      "CREATE TRIGGER task_index_ad AFTER DELETE ON tasks BEGIN\n  DELETE FROM task_words WHERE rowid = old.id;\n  DELETE FROM task_stems WHERE rowid = old.id;\n  DELETE FROM task_index_pending WHERE indexable_type = 'task' AND id = old.id;\nEND;",
      "INSERT OR IGNORE INTO search_index_state (name, watermark, filled_through, terms_through, normalizer_version, built_at, analyzer)\n  VALUES ('task_index', 0, 0, 0, 1, NULL, NULL);",
      "INSERT OR IGNORE INTO task_index_pending (indexable_type, id) SELECT 'task', id FROM tasks;"
    ]
  },
  {
    "name": "20261015010543_version-15-task-pairs",
    "statements": [
      "CREATE TABLE `task_pairs` (\n\t`id` integer PRIMARY KEY,\n\t`task_id` integer,\n\t`source_locator` text,\n\t`other_id` integer NOT NULL,\n\t`score` integer NOT NULL,\n\t`band` text NOT NULL,\n\t`levels` text NOT NULL,\n\t`reasons` text NOT NULL,\n\t`decision` text NOT NULL,\n\t`decided_by_type` text,\n\t`decided_by_id` integer,\n\t`decided_at` integer,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `fk_task_pairs_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`),\n\tCONSTRAINT `fk_task_pairs_other_id_tasks_id_fk` FOREIGN KEY (`other_id`) REFERENCES `tasks`(`id`),\n\tCONSTRAINT `task_pairs_task_id_other_id_unique` UNIQUE(`task_id`,`other_id`)\n);",
      "CREATE INDEX `task_pairs_by_decision_created_at` ON `task_pairs` (`decision`,`created_at`);",
      "CREATE INDEX `task_pairs_by_other_id` ON `task_pairs` (`other_id`);",
      "CREATE INDEX `task_pairs_by_decided_by_type_decided_by_id` ON `task_pairs` (`decided_by_type`,`decided_by_id`);"
    ]
  },
  {
    "name": "20261015014428_version-16-mentions-in-other-texts",
    "statements": [
      "-- Documents, notes and mail have text of their own: queue it for mentions as a message's text is, again when it\n-- changes or is deleted (a soft delete too, so its mentions go), and drop its mentions with the row. Rows stored\n-- before version 16 wait for `mentions rebuild`, as messages stored before version 7 do.\nCREATE TRIGGER mention_pending_document_ai AFTER INSERT ON documents WHEN coalesce(new.body, '') <> '' BEGIN\n  INSERT OR IGNORE INTO mention_pending (source_type, source_id) VALUES ('document', new.id);\nEND;",
      "CREATE TRIGGER mention_pending_document_au AFTER UPDATE OF body, deleted_at ON documents\n  WHEN old.body IS NOT new.body OR old.deleted_at IS NOT new.deleted_at BEGIN\n  INSERT OR IGNORE INTO mention_pending (source_type, source_id) VALUES ('document', new.id);\nEND;",
      "CREATE TRIGGER mentions_document_ad AFTER DELETE ON documents BEGIN\n  DELETE FROM mentions WHERE source_type = 'document' AND source_id = old.id;\n  DELETE FROM mention_pending WHERE source_type = 'document' AND source_id = old.id;\nEND;",
      "CREATE TRIGGER mention_pending_note_ai AFTER INSERT ON notes WHEN coalesce(new.body, '') <> '' BEGIN\n  INSERT OR IGNORE INTO mention_pending (source_type, source_id) VALUES ('note', new.id);\nEND;",
      "CREATE TRIGGER mention_pending_note_au AFTER UPDATE OF body, deleted_at ON notes\n  WHEN old.body IS NOT new.body OR old.deleted_at IS NOT new.deleted_at BEGIN\n  INSERT OR IGNORE INTO mention_pending (source_type, source_id) VALUES ('note', new.id);\nEND;",
      "CREATE TRIGGER mentions_note_ad AFTER DELETE ON notes BEGIN\n  DELETE FROM mentions WHERE source_type = 'note' AND source_id = old.id;\n  DELETE FROM mention_pending WHERE source_type = 'note' AND source_id = old.id;\nEND;",
      "CREATE TRIGGER mention_pending_email_ai AFTER INSERT ON emails WHEN coalesce(new.body_text, '') <> '' BEGIN\n  INSERT OR IGNORE INTO mention_pending (source_type, source_id) VALUES ('email', new.id);\nEND;",
      "CREATE TRIGGER mention_pending_email_au AFTER UPDATE OF body_text, deleted_at ON emails\n  WHEN old.body_text IS NOT new.body_text OR old.deleted_at IS NOT new.deleted_at BEGIN\n  INSERT OR IGNORE INTO mention_pending (source_type, source_id) VALUES ('email', new.id);\nEND;",
      "CREATE TRIGGER mentions_email_ad AFTER DELETE ON emails BEGIN\n  DELETE FROM mentions WHERE source_type = 'email' AND source_id = old.id;\n  DELETE FROM mention_pending WHERE source_type = 'email' AND source_id = old.id;\nEND;"
    ]
  },
  {
    "name": "20261016091439_version-17-agent-close",
    "statements": [
      "ALTER TABLE `tasks` ADD `close_certainty` real;",
      "ALTER TABLE `tasks` ADD `close_suggested_as` text;",
      "ALTER TABLE `tasks` ADD `close_suggested_by_type` text;",
      "ALTER TABLE `tasks` ADD `close_suggested_by_id` integer;",
      "ALTER TABLE `tasks` ADD `close_suggested_certainty` real;",
      "ALTER TABLE `tasks` ADD `close_suggested_reason` text;",
      "ALTER TABLE `tasks` ADD `close_suggested_at` integer;",
      "CREATE INDEX `tasks_by_close_suggested_by_type_close_suggested_by_id` ON `tasks` (`close_suggested_by_type`,`close_suggested_by_id`);"
    ]
  },
  {
    "name": "20261016205235_version-18-places",
    "statements": [
      "CREATE TABLE `places` (\n\t`id` integer PRIMARY KEY,\n\t`address` text NOT NULL,\n\t`folded` text NOT NULL UNIQUE,\n\t`author` text NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL\n);"
    ]
  },
  {
    "name": "20261017000856_version-19-mail-sender-score",
    "statements": [
      "ALTER TABLE `account_identities` ADD `mail_score` integer;",
      "ALTER TABLE `account_identities` ADD `mail_signals` text;",
      "ALTER TABLE `account_identities` ADD `mail_scored_at` integer;"
    ]
  },
  {
    "name": "20261017095620_version-20-poll-votes",
    "statements": [
      "CREATE TABLE `poll_votes` (\n\t`id` integer PRIMARY KEY,\n\t`chat_id` integer NOT NULL,\n\t`message_external_id` text NOT NULL,\n\t`identity_id` integer NOT NULL,\n\t`answers` text NOT NULL,\n\t`voted_at` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `fk_poll_votes_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`),\n\tCONSTRAINT `fk_poll_votes_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`),\n\tCONSTRAINT `poll_votes_chat_id_message_external_id_identity_id_unique` UNIQUE(`chat_id`,`message_external_id`,`identity_id`)\n);",
      "CREATE INDEX `poll_votes_by_identity_id` ON `poll_votes` (`identity_id`);"
    ]
  },
  {
    "name": "20261017141028_version-21-document-annotation-transfers",
    "statements": [
      "CREATE TABLE `document_annotation_transfers` (\n\t`source_key` text NOT NULL,\n\t`collection` text NOT NULL,\n\t`snapshot_hash` text NOT NULL,\n\t`bindings_hash` text NOT NULL,\n\t`reference_map` text NOT NULL,\n\t`created_at` integer NOT NULL,\n\tCONSTRAINT `document_annotation_transfers_pk` PRIMARY KEY(`source_key`, `collection`)\n);"
    ]
  },
  {
    "name": "20261017212239_version-22-mail-demoted",
    "statements": [
      "ALTER TABLE `account_identities` ADD `mail_demoted` integer;"
    ]
  },
  {
    "name": "20261018024850_version-23-chat-events",
    "statements": [
      "CREATE TABLE `chat_event_people` (\n\t`chat_event_id` integer NOT NULL,\n\t`identity_id` integer NOT NULL,\n\tCONSTRAINT `chat_event_people_pk` PRIMARY KEY(`chat_event_id`, `identity_id`),\n\tCONSTRAINT `fk_chat_event_people_chat_event_id_chat_events_id_fk` FOREIGN KEY (`chat_event_id`) REFERENCES `chat_events`(`id`),\n\tCONSTRAINT `fk_chat_event_people_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`)\n);",
      "CREATE TABLE `chat_events` (\n\t`id` integer PRIMARY KEY,\n\t`chat_id` integer NOT NULL,\n\t`source_id` text NOT NULL,\n\t`action` text NOT NULL,\n\t`actor_identity_id` integer,\n\t`title` text,\n\t`happened_at` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `fk_chat_events_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`),\n\tCONSTRAINT `fk_chat_events_actor_identity_id_identities_id_fk` FOREIGN KEY (`actor_identity_id`) REFERENCES `identities`(`id`),\n\tCONSTRAINT `chat_events_chat_id_source_id_unique` UNIQUE(`chat_id`,`source_id`)\n);",
      "CREATE INDEX `chat_event_people_by_identity_id` ON `chat_event_people` (`identity_id`);",
      "CREATE INDEX `chat_events_by_chat_id_happened_at` ON `chat_events` (`chat_id`,`happened_at`);",
      "CREATE INDEX `chat_events_by_actor_identity_id` ON `chat_events` (`actor_identity_id`);"
    ]
  },
  {
    "name": "20261018061512_version-24-message-stars",
    "statements": [
      "ALTER TABLE `messages` ADD `starred` integer;"
    ]
  },
  {
    "name": "20261018063952_version-24-message-stars-index",
    "statements": [
      "CREATE INDEX `messages_starred_by_time` ON `messages` (`chat_id`,\"sent_at\" desc) WHERE starred = 1;"
    ]
  },
  {
    "name": "20261019115025_version-25-chat-revisions",
    "statements": [
      "CREATE TABLE `chat_revision_source` (\n\t`id` integer PRIMARY KEY,\n\t`source` text NOT NULL,\n\t`at` integer NOT NULL\n);",
      "CREATE TABLE `chat_revisions` (\n\t`id` integer PRIMARY KEY,\n\t`chat_id` integer NOT NULL,\n\t`account_id` integer NOT NULL,\n\t`field` text NOT NULL,\n\t`old_value` text,\n\t`new_value` text,\n\t`source` text,\n\t`created_at` integer NOT NULL\n);",
      "CREATE INDEX `chat_revisions_by_chat_id_created_at` ON `chat_revisions` (`chat_id`,`created_at`);",
      "CREATE INDEX `chat_revisions_by_account_id_old_value` ON `chat_revisions` (`account_id`,`old_value`) WHERE field = 'external_id';"
    ]
  },
  {
    "name": "20261019115027_version-25-chat-revisions-triggers",
    "statements": [
      "CREATE TRIGGER chat_revisions_au AFTER UPDATE OF external_id, title, membership_state, scope, searchable, parent_chat_id ON chats BEGIN\n  INSERT INTO chat_revisions (chat_id, account_id, field, old_value, new_value, source, created_at)\n  SELECT new.id, new.account_id, f.field, f.old_value, f.new_value, s.source,\n    coalesce(s.at, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))\n  FROM (\n    SELECT 'external_id' AS field, old.external_id AS old_value, new.external_id AS new_value\n    UNION ALL SELECT 'title', old.title, new.title\n    UNION ALL SELECT 'membership_state', old.membership_state, new.membership_state\n    UNION ALL SELECT 'scope', old.scope, new.scope\n    UNION ALL SELECT 'searchable', old.searchable, new.searchable\n    UNION ALL SELECT 'parent_chat_id', old.parent_chat_id, new.parent_chat_id\n  ) f\n  LEFT JOIN chat_revision_source s ON s.id = 1\n  WHERE f.old_value IS NOT f.new_value;\nEND;",
      "CREATE TRIGGER chat_revisions_ad AFTER DELETE ON chats BEGIN\n  DELETE FROM chat_revisions WHERE chat_id = old.id;\nEND;"
    ]
  },
  {
    "name": "20261021214318_version-26-message-reactions",
    "statements": [
      "CREATE TABLE `message_reactions` (\n\t`id` integer PRIMARY KEY,\n\t`chat_id` integer NOT NULL,\n\t`message_external_id` text NOT NULL,\n\t`identity_id` integer NOT NULL,\n\t`own` integer NOT NULL,\n\t`reaction` text,\n\t`reacted_at` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `fk_message_reactions_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`),\n\tCONSTRAINT `fk_message_reactions_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`),\n\tCONSTRAINT `message_reactions_chat_id_message_external_id_identity_id_unique` UNIQUE(`chat_id`,`message_external_id`,`identity_id`)\n);",
      "CREATE INDEX `message_reactions_by_identity_id` ON `message_reactions` (`identity_id`);"
    ]
  },
  {
    "name": "20261021221808_version-27-message-delivery",
    "statements": [
      "ALTER TABLE `messages` ADD `delivery` integer;"
    ]
  },
  {
    "name": "20261021224625_version-28-chat-state",
    "statements": [
      "ALTER TABLE `chats` ADD `muted` integer;",
      "ALTER TABLE `chats` ADD `muted_until` integer;",
      "ALTER TABLE `chats` ADD `archived` integer;",
      "ALTER TABLE `chats` ADD `marked_unread` integer;",
      "ALTER TABLE `chats` ADD `unread_counted_at` integer;"
    ]
  },
  {
    "name": "20261023105057_version-29-transcript-words",
    "statements": [
      "CREATE TABLE `transcript_index_pending` (\n\t`id` integer NOT NULL,\n\t`indexable_type` text NOT NULL,\n\tCONSTRAINT `transcript_index_pending_pk` PRIMARY KEY(`indexable_type`, `id`)\n);"
    ]
  },
  {
    "name": "20261023105101_version-29-transcript-words-triggers",
    "statements": [
      "-- Words and stems of a voice note's transcript, rowid = attachment id. The words are the vocabulary garbled\n-- spellings are read from; the typed form is still found in attachment_words. Stemming needs JS, so the\n-- triggers only queue the attachment and the next search indexes it, as tasks do.\nCREATE VIRTUAL TABLE transcript_words USING fts5(\n  normalized_text, scope,\n  content = '', contentless_delete = 1,\n  tokenize = 'unicode61 remove_diacritics 2', prefix = '3');",
      "CREATE VIRTUAL TABLE transcript_words_vocab USING fts5vocab(transcript_words, 'col');",
      "CREATE VIRTUAL TABLE transcript_stems USING fts5(\n  stems, scope,\n  content = '', contentless_delete = 1,\n  tokenize = 'unicode61 remove_diacritics 2');",
      "-- A transcript is the text of a message's voice attachment, whoever wrote it, as `speech()` in lucene-fields.ts.\nCREATE TRIGGER transcript_index_ai AFTER INSERT ON attachments\n  WHEN new.attachable_type = 'message' AND (coalesce(new.extractor, '') LIKE 'speech:%'\n    OR new.kind IN ('voice', 'video_note') OR coalesce(new.mime, '') = 'audio/ogg') BEGIN\n  INSERT OR IGNORE INTO transcript_index_pending (indexable_type, id) VALUES ('attachment', new.id);\nEND;",
      "-- Queued whether it became a transcript or stopped being one: the drain drops what is no longer live.\nCREATE TRIGGER transcript_index_au AFTER UPDATE OF text, kind, mime, extractor, attachable_type ON attachments\n  WHEN (old.text IS NOT new.text OR old.kind IS NOT new.kind OR old.mime IS NOT new.mime\n    OR old.extractor IS NOT new.extractor OR old.attachable_type IS NOT new.attachable_type)\n    AND ((new.attachable_type = 'message' AND (coalesce(new.extractor, '') LIKE 'speech:%'\n      OR new.kind IN ('voice', 'video_note') OR coalesce(new.mime, '') = 'audio/ogg'))\n    OR (old.attachable_type = 'message' AND (coalesce(old.extractor, '') LIKE 'speech:%'\n      OR old.kind IN ('voice', 'video_note') OR coalesce(old.mime, '') = 'audio/ogg'))) BEGIN\n  INSERT OR IGNORE INTO transcript_index_pending (indexable_type, id) VALUES ('attachment', new.id);\nEND;",
      "CREATE TRIGGER transcript_index_ad AFTER DELETE ON attachments BEGIN\n  DELETE FROM transcript_words WHERE rowid = old.id;\n  DELETE FROM transcript_stems WHERE rowid = old.id;\n  DELETE FROM transcript_index_pending WHERE indexable_type = 'attachment' AND id = old.id;\nEND;",
      "INSERT OR IGNORE INTO search_index_state (name, watermark, filled_through, terms_through, normalizer_version, built_at, analyzer)\n  VALUES ('transcript_index', 0, 0, 0, 1, NULL, NULL);",
      "INSERT OR IGNORE INTO transcript_index_pending (indexable_type, id)\n  SELECT 'attachment', id FROM attachments WHERE attachable_type = 'message' AND coalesce(text, '') <> ''\n    AND (coalesce(extractor, '') LIKE 'speech:%' OR kind IN ('voice', 'video_note') OR coalesce(mime, '') = 'audio/ogg');"
    ]
  },
  {
    "name": "20261025064253_version-30-reviewed-tag-consolidation",
    "statements": [
      "CREATE TABLE `tag_consolidations` (\n\t`id` integer PRIMARY KEY,\n\t`source_id` integer NOT NULL,\n\t`survivor_id` integer NOT NULL,\n\t`source_member_ids` text NOT NULL,\n\t`survivor_member_ids` text NOT NULL,\n\t`actor_type` text NOT NULL,\n\t`actor_id` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`idempotency_key` text NOT NULL UNIQUE,\n\t`vocabulary_fingerprint` text NOT NULL,\n\t`preview_fingerprint` text NOT NULL,\n\t`counts` text NOT NULL,\n\t`request_fingerprint` text NOT NULL,\n\tCONSTRAINT `fk_tag_consolidations_source_id_canonical_tags_id_fk` FOREIGN KEY (`source_id`) REFERENCES `canonical_tags`(`id`),\n\tCONSTRAINT `fk_tag_consolidations_survivor_id_canonical_tags_id_fk` FOREIGN KEY (`survivor_id`) REFERENCES `canonical_tags`(`id`)\n);",
      "CREATE TABLE `tag_redirects` (\n\t`source_id` integer PRIMARY KEY,\n\t`survivor_id` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\tCONSTRAINT `fk_tag_redirects_source_id_canonical_tags_id_fk` FOREIGN KEY (`source_id`) REFERENCES `canonical_tags`(`id`),\n\tCONSTRAINT `fk_tag_redirects_survivor_id_canonical_tags_id_fk` FOREIGN KEY (`survivor_id`) REFERENCES `canonical_tags`(`id`)\n);",
      "ALTER TABLE `auto_tag_claims` RENAME TO `canonical_auto_tag_claims`;",
      "ALTER TABLE `tags` RENAME TO `canonical_tags`;",
      "DROP INDEX IF EXISTS `auto_tag_claims_by_tag_id`;",
      "CREATE INDEX `canonical_auto_tag_claims_by_tag_id` ON `canonical_auto_tag_claims` (`tag_id`);",
      "CREATE INDEX `tag_consolidations_by_source_id` ON `tag_consolidations` (`source_id`);",
      "CREATE INDEX `tag_consolidations_by_survivor_id` ON `tag_consolidations` (`survivor_id`);",
      "CREATE INDEX `tag_consolidations_by_actor_type_actor_id` ON `tag_consolidations` (`actor_type`,`actor_id`);",
      "CREATE INDEX `tag_redirects_by_survivor_id` ON `tag_redirects` (`survivor_id`);"
    ]
  },
  {
    "name": "20261025064302_version-30-resolved-tag-view",
    "statements": [
      "CREATE VIEW resolved_tags AS\nSELECT original.id,canonical.name,canonical.kind,canonical.id AS canonical_id,original.created_at,original.updated_at\nFROM canonical_tags original\nLEFT JOIN tag_redirects r ON r.source_id=original.id\nJOIN canonical_tags canonical ON canonical.id=coalesce(r.survivor_id,original.id);"
    ]
  },
  {
    "name": "20261025070402_version-31-drive-account",
    "statements": [
      "-- Drive documents leave their stand-in notes folder (`folder`, named `google-drive:<principal>`) for the\n-- principal's `google-drive` account, by UPDATE, so every `document:<id>` reference holds. One folder per\n-- principal moves, the oldest; a duplicate, or one whose files the account already holds, stays a folder.\nCREATE TEMP TABLE drive_moves (folder_id INTEGER PRIMARY KEY, principal TEXT NOT NULL, account_id INTEGER);",
      "INSERT INTO temp.drive_moves (folder_id, principal)\nSELECT f.id, substr(f.name, 14) FROM accounts f\nWHERE f.provider = 'folder' AND substr(f.name, 1, 13) = 'google-drive:' AND length(f.name) > 13\n  AND f.id = (SELECT min(o.id) FROM accounts o WHERE o.provider = 'folder' AND o.name = f.name)\n  AND NOT EXISTS (\n    SELECT 1 FROM documents held JOIN accounts g ON g.id = held.account_id\n    WHERE g.provider = 'google-drive' AND g.external_id = substr(f.name, 14)\n      AND held.external_id IN (SELECT external_id FROM documents WHERE account_id = f.id)\n  );",
      "INSERT OR IGNORE INTO accounts (provider, external_id, name, scope, organization_id, created_at, updated_at)\nSELECT 'google-drive', m.principal, 'Google Drive', f.scope, f.organization_id, f.created_at, f.updated_at\nFROM temp.drive_moves m JOIN accounts f ON f.id = m.folder_id;",
      "UPDATE temp.drive_moves SET account_id = (\n  SELECT id FROM accounts WHERE provider = 'google-drive' AND external_id = drive_moves.principal\n);",
      "UPDATE accounts SET\n  settings = (\n    SELECT json_set(\n      CASE WHEN json_valid(accounts.settings) AND json_type(accounts.settings) = 'object' THEN accounts.settings ELSE '{}' END,\n      '$.format', coalesce(CASE WHEN json_valid(f.settings) THEN json_extract(f.settings, '$.format') END, 'markdown'),\n      '$.movedFrom', json_object('id', f.id, 'external_id', f.external_id, 'name', f.name)\n    )\n    FROM temp.drive_moves m JOIN accounts f ON f.id = m.folder_id WHERE m.account_id = accounts.id\n  ),\n  scope = (SELECT f.scope FROM temp.drive_moves m JOIN accounts f ON f.id = m.folder_id WHERE m.account_id = accounts.id),\n  organization_id = (\n    SELECT f.organization_id FROM temp.drive_moves m JOIN accounts f ON f.id = m.folder_id WHERE m.account_id = accounts.id\n  )\nWHERE id IN (SELECT account_id FROM temp.drive_moves);",
      "UPDATE account_identities SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = account_identities.account_id)\nWHERE account_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE aliases SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = aliases.account_id)\nWHERE account_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE bot_updates SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = bot_updates.account_id)\nWHERE account_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE chats SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = chats.account_id)\nWHERE account_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE chunks SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = chunks.account_id)\nWHERE account_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE documents SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = documents.account_id)\nWHERE account_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE email_threads SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = email_threads.account_id)\nWHERE account_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE emails SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = emails.account_id)\nWHERE account_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE involvements SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = involvements.account_id)\nWHERE account_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE mailboxes SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = mailboxes.account_id)\nWHERE account_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE mail_rules SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = mail_rules.account_id)\nWHERE account_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE meeting_series SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = meeting_series.account_id)\nWHERE account_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE meetings SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = meetings.account_id)\nWHERE account_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE messages SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = messages.account_id)\nWHERE account_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE projects SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = projects.account_id)\nWHERE account_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE proposed_actions SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = proposed_actions.account_id)\nWHERE account_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE reminders SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = reminders.account_id)\nWHERE account_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE sync_cursors SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = sync_cursors.account_id)\nWHERE account_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE syncs SET account_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = syncs.account_id)\nWHERE account_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE agent_actions SET actor_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = agent_actions.actor_id)\nWHERE actor_type = 'account' AND actor_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE agent_actions SET target_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = agent_actions.target_id)\nWHERE target_type = 'account' AND target_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE aliases SET aliasable_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = aliases.aliasable_id)\nWHERE aliasable_type = 'account' AND aliasable_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE attachments SET attachable_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = attachments.attachable_id)\nWHERE attachable_type = 'account' AND attachable_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE chunks SET chunkable_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = chunks.chunkable_id)\nWHERE chunkable_type = 'account' AND chunkable_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE involvements SET subject_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = involvements.subject_id)\nWHERE subject_type = 'account' AND subject_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE links SET from_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = links.from_id)\nWHERE from_type = 'account' AND from_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE links SET to_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = links.to_id)\nWHERE to_type = 'account' AND to_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE memories SET subject_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = memories.subject_id)\nWHERE subject_type = 'account' AND subject_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE notes SET notable_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = notes.notable_id)\nWHERE notable_type = 'account' AND notable_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE proposed_actions SET target_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = proposed_actions.target_id)\nWHERE target_type = 'account' AND target_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE taggings SET taggable_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = taggings.taggable_id)\nWHERE taggable_type = 'account' AND taggable_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE facts SET subject_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = facts.subject_id)\nWHERE subject_type = 'account' AND subject_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE mention_pending SET source_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = mention_pending.source_id)\nWHERE source_type = 'account' AND source_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE mentions SET source_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = mentions.source_id)\nWHERE source_type = 'account' AND source_id IN (SELECT folder_id FROM temp.drive_moves);",
      "UPDATE mentions SET target_id = (SELECT account_id FROM temp.drive_moves WHERE folder_id = mentions.target_id)\nWHERE target_type = 'account' AND target_id IN (SELECT folder_id FROM temp.drive_moves);",
      "-- A profile that named the folder names the account: `{ provider: \"google-drive\", account: <principal> }`.\nUPDATE store_settings SET value = (\n  SELECT json_group_object(app.key, CASE WHEN app.type = 'object' THEN (\n    SELECT json_group_object(profile.key, CASE\n      WHEN profile.type = 'object' AND json_extract(profile.value, '$.provider') = 'folder'\n        AND json_extract(profile.value, '$.account') IN (SELECT 'google-drive:' || principal FROM temp.drive_moves)\n      THEN json_set(profile.value, '$.provider', 'google-drive', '$.account', substr(json_extract(profile.value, '$.account'), 14))\n      WHEN profile.type IN ('object', 'array') THEN json(profile.value)\n      ELSE profile.value END)\n    FROM json_each(app.value) profile\n  ) WHEN app.type = 'array' THEN json(app.value) ELSE app.value END)\n  FROM json_each(store_settings.value) app\n)\nWHERE key = 'profiles' AND json_valid(value) AND json_type(value) = 'object'\n  AND EXISTS (SELECT 1 FROM temp.drive_moves);",
      "-- A group member `notes:<folder id>` follows the documents to `notes:<account id>`.\nUPDATE store_settings SET value = (\n  SELECT json_group_object(grp.key, CASE WHEN grp.type = 'array' THEN (\n    SELECT json_group_array(coalesce(\n      (SELECT 'notes:' || m.account_id FROM temp.drive_moves m WHERE 'notes:' || m.folder_id = member.value),\n      member.value))\n    FROM json_each(grp.value) member\n  ) WHEN grp.type = 'object' THEN json(grp.value) ELSE grp.value END)\n  FROM json_each(store_settings.value) grp\n)\nWHERE key = 'accountGroups' AND json_valid(value) AND json_type(value) = 'object'\n  AND EXISTS (SELECT 1 FROM temp.drive_moves);",
      "DELETE FROM accounts WHERE id IN (SELECT folder_id FROM temp.drive_moves);",
      "DROP TABLE temp.drive_moves;"
    ]
  },
  {
    "name": "20261025071848_version-32-files",
    "statements": [
      "CREATE TABLE `entity_link_events` (\n\t`id` integer PRIMARY KEY,\n\t`linkable_type` text NOT NULL,\n\t`linkable_id` integer NOT NULL,\n\t`entity_type` text NOT NULL,\n\t`from_entity_id` integer,\n\t`to_entity_id` integer,\n\t`method` text NOT NULL,\n\t`confidence` real,\n\t`author` text NOT NULL,\n\t`created_at` integer NOT NULL\n);",
      "CREATE TABLE `files` (\n\t`id` integer PRIMARY KEY,\n\t`account_id` integer NOT NULL,\n\t`external_id` text NOT NULL,\n\t`kind` text NOT NULL,\n\t`name` text NOT NULL,\n\t`path` text NOT NULL,\n\t`path_folded` text,\n\t`parent_id` integer,\n\t`document_id` integer,\n\t`mime` text,\n\t`size` integer,\n\t`content_hash` text,\n\t`url` text,\n\t`external_created_at` integer,\n\t`external_updated_at` integer,\n\t`metadata` text,\n\t`seen_at` integer,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\tCONSTRAINT `fk_files_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),\n\tCONSTRAINT `fk_files_parent_id_files_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `files`(`id`),\n\tCONSTRAINT `fk_files_document_id_documents_id_fk` FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`),\n\tCONSTRAINT `files_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)\n);",
      "CREATE TABLE `link_reviews` (\n\t`id` integer PRIMARY KEY,\n\t`linkable_type` text NOT NULL,\n\t`linkable_id` integer NOT NULL,\n\t`entity_type` text NOT NULL,\n\t`candidates` text NOT NULL,\n\t`reason` text NOT NULL,\n\t`status` text NOT NULL,\n\t`chosen_id` integer,\n\t`decided_by` text,\n\t`decided_at` integer,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `link_reviews_linkable_type_linkable_id_entity_type_unique` UNIQUE(`linkable_type`,`linkable_id`,`entity_type`)\n);",
      "ALTER TABLE `documents` ADD `pinned_file_id` integer;",
      "ALTER TABLE `identities` ADD `email` text;",
      "CREATE INDEX `entity_link_events_by_linkable_type_linkable_id` ON `entity_link_events` (`linkable_type`,`linkable_id`);",
      "CREATE INDEX `entity_link_events_by_entity_type_to_entity_id` ON `entity_link_events` (`entity_type`,`to_entity_id`);",
      "CREATE INDEX `files_by_account_id_path_folded` ON `files` (`account_id`,`path_folded`);",
      "CREATE INDEX `files_path_to_fold` ON `files` (`id`) WHERE path_folded IS NULL;",
      "CREATE INDEX `files_by_parent_id` ON `files` (`parent_id`);",
      "CREATE INDEX `files_by_document_id` ON `files` (`document_id`);",
      "CREATE INDEX `identities_by_email` ON `identities` (`email`) WHERE email IS NOT NULL;",
      "CREATE INDEX `link_reviews_by_status_created_at` ON `link_reviews` (`status`,`created_at`);"
    ]
  },
  {
    "name": "20261025071850_version-32-files-data",
    "statements": [
      "-- A folder account's provider says what the folder is. Drive's stand-in folders (`google-drive:<principal>`) keep\n-- `folder`: version 31 moves their documents to the `google-drive` account, and they are no local folder either way.\nUPDATE accounts SET provider = CASE\n    WHEN json_valid(settings) AND json_extract(settings, '$.format') = 'markdown' THEN 'local' ELSE 'obsidian' END\n  WHERE provider = 'folder' AND substr(coalesce(name, ''), 1, 13) <> 'google-drive:';",
      "UPDATE identities SET email = lower(trim(external_id)) WHERE provider = 'email' AND instr(external_id, '@') > 1;",
      "-- A document hard-deleted (a rename onto a gone note's path) takes its file row along; the rename writes its own.\nCREATE TRIGGER files_document_bd BEFORE DELETE ON documents BEGIN\n  DELETE FROM files WHERE document_id = old.id;\nEND;",
      "-- One `files` row per document is written in JS on open (`fillFiles`), from the document after this id.\nINSERT OR REPLACE INTO store_settings (key, value, at) VALUES ('files_backfill_after', '0', unixepoch() * 1000);",
      "-- A mail contact's address is its external id; every writer of one gets the column filled the same way.\nCREATE TRIGGER identities_email_ai AFTER INSERT ON identities\n  WHEN new.provider = 'email' AND new.email IS NULL AND instr(new.external_id, '@') > 1 BEGIN\n  UPDATE identities SET email = lower(trim(new.external_id)) WHERE id = new.id;\nEND;",
      "-- A deleted document keeps its tags: a file moved between folders is revived with them (owner's choice). Its tags go\n-- when the row itself does (`document_bd`), and readers leave out a deleted document's taggings.\nDROP TRIGGER document_tombstone;"
    ]
  },
  {
    "name": "20261025072643_version-33-calendars",
    "statements": [
      "CREATE TABLE `calendar_entries` (\n\t`id` integer PRIMARY KEY,\n\t`calendar_id` integer NOT NULL,\n\t`kind` text NOT NULL,\n\t`series_entry_id` integer,\n\t`event_id` integer,\n\t`event_series_id` integer,\n\t`external_id` text NOT NULL,\n\t`ical_uid` text,\n\t`original_starts_at` integer,\n\t`exception` integer NOT NULL,\n\t`status` text NOT NULL,\n\t`title` text,\n\t`description` text,\n\t`location` text,\n\t`starts_at` integer,\n\t`ends_at` integer,\n\t`all_day` integer NOT NULL,\n\t`start_date` text,\n\t`end_date` text,\n\t`timezone` text,\n\t`recurrence` text,\n\t`recurrence_ends_at` integer,\n\t`event_type` text,\n\t`transparency` text,\n\t`visibility` text,\n\t`own_response` text,\n\t`organizer_identity_id` integer,\n\t`join_url` text,\n\t`join_key` text,\n\t`conference` text,\n\t`url` text,\n\t`sequence` integer,\n\t`etag` text,\n\t`external_updated_at` integer,\n\t`metadata` text,\n\t`seen_at` integer,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\tCONSTRAINT `fk_calendar_entries_calendar_id_calendars_id_fk` FOREIGN KEY (`calendar_id`) REFERENCES `calendars`(`id`),\n\tCONSTRAINT `fk_calendar_entries_series_entry_id_calendar_entries_id_fk` FOREIGN KEY (`series_entry_id`) REFERENCES `calendar_entries`(`id`),\n\tCONSTRAINT `fk_calendar_entries_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`),\n\tCONSTRAINT `fk_calendar_entries_event_series_id_event_series_id_fk` FOREIGN KEY (`event_series_id`) REFERENCES `event_series`(`id`),\n\tCONSTRAINT `fk_calendar_entries_organizer_identity_id_identities_id_fk` FOREIGN KEY (`organizer_identity_id`) REFERENCES `identities`(`id`),\n\tCONSTRAINT `calendar_entries_calendar_id_external_id_unique` UNIQUE(`calendar_id`,`external_id`),\n\tCONSTRAINT `calendar_entries_series_entry_id_original_starts_at_unique` UNIQUE(`series_entry_id`,`original_starts_at`)\n);",
      "CREATE TABLE `calendar_entry_participants` (\n\t`id` integer PRIMARY KEY,\n\t`entry_id` integer NOT NULL,\n\t`identity_id` integer,\n\t`email` text NOT NULL,\n\t`name` text,\n\t`response` text,\n\t`optional` integer NOT NULL,\n\t`organizer` integer NOT NULL,\n\t`self` integer NOT NULL,\n\t`resource` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `fk_calendar_entry_participants_entry_id_calendar_entries_id_fk` FOREIGN KEY (`entry_id`) REFERENCES `calendar_entries`(`id`),\n\tCONSTRAINT `fk_calendar_entry_participants_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`),\n\tCONSTRAINT `calendar_entry_participants_entry_id_email_unique` UNIQUE(`entry_id`,`email`)\n);",
      "CREATE TABLE `calendar_entry_revisions` (\n\t`id` integer PRIMARY KEY,\n\t`entry_id` integer NOT NULL,\n\t`title` text,\n\t`starts_at` integer,\n\t`ends_at` integer,\n\t`location` text,\n\t`status` text,\n\t`recurrence` text,\n\t`recurrence_ends_at` integer,\n\t`external_updated_at` integer,\n\t`created_at` integer NOT NULL,\n\tCONSTRAINT `fk_calendar_entry_revisions_entry_id_calendar_entries_id_fk` FOREIGN KEY (`entry_id`) REFERENCES `calendar_entries`(`id`)\n);",
      "CREATE TABLE `calendars` (\n\t`id` integer PRIMARY KEY,\n\t`account_id` integer NOT NULL,\n\t`external_id` text NOT NULL,\n\t`title` text,\n\t`timezone` text,\n\t`access_role` text,\n\t`primary_calendar` integer NOT NULL,\n\t`synced` integer NOT NULL,\n\t`seen_at` integer,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\tCONSTRAINT `fk_calendars_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),\n\tCONSTRAINT `calendars_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)\n);",
      "CREATE TABLE `event_index_pending` (\n\t`id` integer NOT NULL,\n\t`indexable_type` text NOT NULL,\n\tCONSTRAINT `event_index_pending_pk` PRIMARY KEY(`indexable_type`, `id`)\n);",
      "ALTER TABLE `events` ADD `status` text;",
      "ALTER TABLE `events` ADD `all_day` integer;",
      "ALTER TABLE `events` ADD `source_deleted_at` integer;",
      "ALTER TABLE `meetings` ADD `join_key` text;",
      "CREATE INDEX `calendar_entries_by_calendar_id_starts_at` ON `calendar_entries` (`calendar_id`,`starts_at`);",
      "CREATE INDEX `calendar_entries_by_ical_uid` ON `calendar_entries` (`ical_uid`) WHERE ical_uid IS NOT NULL;",
      "CREATE INDEX `calendar_entries_by_join_key` ON `calendar_entries` (`join_key`) WHERE join_key IS NOT NULL;",
      "CREATE INDEX `calendar_entries_by_event_id` ON `calendar_entries` (`event_id`);",
      "CREATE INDEX `calendar_entries_by_event_series_id` ON `calendar_entries` (`event_series_id`);",
      "CREATE INDEX `calendar_entries_by_event_type_event_id` ON `calendar_entries` (`event_type`,`event_id`);",
      "CREATE INDEX `calendar_entries_by_organizer_identity_id` ON `calendar_entries` (`organizer_identity_id`);",
      "CREATE INDEX `calendar_entry_participants_by_identity_id` ON `calendar_entry_participants` (`identity_id`);",
      "CREATE INDEX `calendar_entry_revisions_by_entry_id_created_at` ON `calendar_entry_revisions` (`entry_id`,`created_at`);",
      "CREATE INDEX `meetings_by_join_key` ON `meetings` (`join_key`) WHERE join_key IS NOT NULL;",
      "CREATE INDEX `meetings_join_key_to_fill` ON `meetings` (`id`) WHERE join_url IS NOT NULL AND join_key IS NULL;"
    ]
  },
  {
    "name": "20261025072644_version-33-calendars-triggers",
    "statements": [
      "-- The event is indexed, not each entry: its title, description and location, and the names its entries list.\n-- Stemming needs JS, so the triggers only queue the event and the next search indexes it, as tasks do.\nCREATE VIRTUAL TABLE event_words USING fts5(\n  normalized_text, scope,\n  content = '', contentless_delete = 1,\n  tokenize = 'unicode61 remove_diacritics 2', prefix = '3');",
      "CREATE VIRTUAL TABLE event_words_vocab USING fts5vocab(event_words, 'col');",
      "CREATE VIRTUAL TABLE event_stems USING fts5(\n  stems, scope,\n  content = '', contentless_delete = 1,\n  tokenize = 'unicode61 remove_diacritics 2');",
      "CREATE TRIGGER event_index_ai AFTER INSERT ON events BEGIN\n  INSERT OR IGNORE INTO event_index_pending (indexable_type, id) VALUES ('event', new.id);\nEND;",
      "CREATE TRIGGER event_index_au AFTER UPDATE OF title, description, location, deleted_at ON events\n  WHEN old.title IS NOT new.title OR old.description IS NOT new.description OR old.location IS NOT new.location\n    OR old.deleted_at IS NOT new.deleted_at BEGIN\n  INSERT OR IGNORE INTO event_index_pending (indexable_type, id) VALUES ('event', new.id);\nEND;",
      "CREATE TRIGGER event_index_ad AFTER DELETE ON events BEGIN\n  DELETE FROM event_words WHERE rowid = old.id;\n  DELETE FROM event_stems WHERE rowid = old.id;\n  DELETE FROM event_index_pending WHERE indexable_type = 'event' AND id = old.id;\nEND;",
      "-- An entry that joins or leaves an event, or changes kind, changes what the event is found by.\nCREATE TRIGGER event_index_entry_au AFTER UPDATE OF event_id, event_type, deleted_at ON calendar_entries\n  WHEN old.event_id IS NOT new.event_id OR old.event_type IS NOT new.event_type OR old.deleted_at IS NOT new.deleted_at BEGIN\n  INSERT OR IGNORE INTO event_index_pending (indexable_type, id)\n    SELECT 'event', value FROM (SELECT old.event_id AS value UNION SELECT new.event_id) WHERE value IS NOT NULL;\nEND;",
      "CREATE TRIGGER event_index_participant_ai AFTER INSERT ON calendar_entry_participants BEGIN\n  INSERT OR IGNORE INTO event_index_pending (indexable_type, id)\n    SELECT 'event', event_id FROM calendar_entries WHERE id = new.entry_id AND event_id IS NOT NULL;\nEND;",
      "CREATE TRIGGER event_index_participant_au AFTER UPDATE OF name ON calendar_entry_participants\n  WHEN old.name IS NOT new.name BEGIN\n  INSERT OR IGNORE INTO event_index_pending (indexable_type, id)\n    SELECT 'event', event_id FROM calendar_entries WHERE id = new.entry_id AND event_id IS NOT NULL;\nEND;",
      "CREATE TRIGGER event_index_participant_ad AFTER DELETE ON calendar_entry_participants BEGIN\n  INSERT OR IGNORE INTO event_index_pending (indexable_type, id)\n    SELECT 'event', event_id FROM calendar_entries WHERE id = old.entry_id AND event_id IS NOT NULL;\nEND;",
      "CREATE TRIGGER calendar_entries_time_bi BEFORE INSERT ON calendar_entries\n  WHEN new.ends_at < new.starts_at BEGIN\n  SELECT RAISE(ABORT, 'a calendar entry cannot end before it starts');\nEND;",
      "CREATE TRIGGER calendar_entries_time_bu BEFORE UPDATE OF starts_at, ends_at ON calendar_entries\n  WHEN new.ends_at < new.starts_at BEGIN\n  SELECT RAISE(ABORT, 'a calendar entry cannot end before it starts');\nEND;",
      "INSERT OR IGNORE INTO search_index_state (name, watermark, filled_through, terms_through, normalizer_version, built_at, analyzer)\n  VALUES ('event_index', 0, 0, 0, 1, NULL, NULL);",
      "INSERT OR IGNORE INTO event_index_pending (indexable_type, id) SELECT 'event', id FROM events;"
    ]
  },
  {
    "name": "20261025182500_version-34-vector-index",
    "statements": [
      "CREATE TABLE `vector_index_redo` (\n\t`chunk_id` integer NOT NULL\n);",
      "CREATE TABLE `vector_indexes` (\n\t`id` integer PRIMARY KEY,\n\t`model` text NOT NULL UNIQUE,\n\t`dims` integer NOT NULL,\n\t`ready` integer NOT NULL,\n\t`filled_through` text NOT NULL\n);"
    ]
  },
  {
    "name": "20261025182501_version-34-vector-index-triggers",
    "statements": [
      "-- Every change that can add, drop or move a chunk's vector passes the chunk's id through vector_index_redo, where\n-- each model's own trigger (made with its vec0 table, `vector-index.ts`) re-derives that row. Writes in TypeScript\n-- and the schema's own delete triggers (document_bd, note_bd, …) all reach the index this way.\n-- A chunk usually comes before its vector; the vector's own trigger indexes it then.\n-- CROSS JOIN: led by the vectors, SQLite read every one of them per chunk (7 ms each at 100k).\nCREATE TRIGGER vector_index_chunk_ai AFTER INSERT ON chunks WHEN EXISTS (SELECT 1 FROM vector_indexes i\n    CROSS JOIN embeddings v ON v.model = i.model AND v.content_hash = new.content_hash) BEGIN\n  INSERT INTO vector_index_redo (chunk_id) VALUES (new.id);\n  DELETE FROM vector_index_redo;\nEND;",
      "CREATE TRIGGER vector_index_chunk_ad AFTER DELETE ON chunks BEGIN\n  INSERT INTO vector_index_redo (chunk_id) VALUES (old.id);\n  DELETE FROM vector_index_redo;\nEND;",
      "CREATE TRIGGER vector_index_chunk_au AFTER UPDATE OF content_hash, chunkable_type, chunkable_id, account_id, occurred_at\n  ON chunks WHEN old.content_hash IS NOT new.content_hash OR old.chunkable_type IS NOT new.chunkable_type\n    OR old.chunkable_id IS NOT new.chunkable_id OR old.account_id IS NOT new.account_id\n    OR old.occurred_at IS NOT new.occurred_at BEGIN\n  INSERT INTO vector_index_redo (chunk_id) VALUES (new.id);\n  DELETE FROM vector_index_redo;\nEND;",
      "CREATE TRIGGER vector_index_embedding_ai AFTER INSERT ON embeddings\n  WHEN EXISTS (SELECT 1 FROM vector_indexes WHERE model = new.model) BEGIN\n  INSERT INTO vector_index_redo (chunk_id) SELECT id FROM chunks WHERE content_hash = new.content_hash;\n  DELETE FROM vector_index_redo;\nEND;",
      "CREATE TRIGGER vector_index_embedding_ad AFTER DELETE ON embeddings\n  WHEN EXISTS (SELECT 1 FROM vector_indexes WHERE model = old.model) BEGIN\n  INSERT INTO vector_index_redo (chunk_id) SELECT id FROM chunks WHERE content_hash = old.content_hash;\n  DELETE FROM vector_index_redo;\nEND;",
      "CREATE TRIGGER vector_index_embedding_au AFTER UPDATE OF model, content_hash, vector ON embeddings BEGIN\n  INSERT INTO vector_index_redo (chunk_id)\n    SELECT id FROM chunks WHERE content_hash = old.content_hash OR content_hash = new.content_hash;\n  DELETE FROM vector_index_redo;\nEND;",
      "-- A message's chunk and its images' chunks are indexed under its chat and send time; a chat merge moves messages.\nCREATE TRIGGER vector_index_message_au AFTER UPDATE OF chat_id, sent_at ON messages\n  WHEN old.chat_id IS NOT new.chat_id OR old.sent_at IS NOT new.sent_at BEGIN\n  INSERT INTO vector_index_redo (chunk_id)\n    SELECT id FROM chunks WHERE chunkable_type = 'message' AND chunkable_id = new.id\n    UNION ALL SELECT k.id FROM attachments a JOIN chunks k ON k.chunkable_type = 'image' AND k.chunkable_id = a.id\n      WHERE a.attachable_type = 'message' AND a.attachable_id = new.id;\n  DELETE FROM vector_index_redo;\nEND;",
      "-- An image's chat and account come from its message; a chat merge moves attachments to the kept copy.\nCREATE TRIGGER vector_index_attachment_au AFTER UPDATE OF attachable_type, attachable_id ON attachments\n  WHEN old.attachable_type IS NOT new.attachable_type OR old.attachable_id IS NOT new.attachable_id BEGIN\n  INSERT INTO vector_index_redo (chunk_id) SELECT id FROM chunks WHERE chunkable_type = 'image' AND chunkable_id = new.id;\n  DELETE FROM vector_index_redo;\nEND;",
      "CREATE TRIGGER vector_index_conversation_au AFTER UPDATE OF chat_id ON conversations\n  WHEN old.chat_id IS NOT new.chat_id BEGIN\n  INSERT INTO vector_index_redo (chunk_id)\n    SELECT id FROM chunks WHERE chunkable_type = 'conversation' AND chunkable_id = new.id;\n  DELETE FROM vector_index_redo;\nEND;",
      "-- Images and conversations are indexed under their chat's account; messages carry their own.\nCREATE TRIGGER vector_index_chat_au AFTER UPDATE OF account_id ON chats WHEN old.account_id IS NOT new.account_id BEGIN\n  INSERT INTO vector_index_redo (chunk_id)\n    SELECT k.id FROM messages m JOIN attachments a ON a.attachable_type = 'message' AND a.attachable_id = m.id\n      JOIN chunks k ON k.chunkable_type = 'image' AND k.chunkable_id = a.id WHERE m.chat_id = new.id\n    UNION ALL SELECT k.id FROM conversations c JOIN chunks k ON k.chunkable_type = 'conversation' AND k.chunkable_id = c.id\n      WHERE c.chat_id = new.id;\n  DELETE FROM vector_index_redo;\nEND;"
    ]
  },
  {
    "name": "20261027102259_version-35-calendar-neutral",
    "statements": [
      "ALTER TABLE `calendar_entries` ADD `series_external_id` text;",
      "CREATE INDEX `calendar_entries_by_calendar_id_series_external_id` ON `calendar_entries` (`calendar_id`,`series_external_id`) WHERE series_external_id IS NOT NULL;"
    ]
  },
  {
    "name": "20261027102302_version-35-calendar-neutral-data",
    "statements": [
      "-- `metadata.recurring_event_id` stays on the rows it is on: a version-34 build may still open this file and reads it.\nUPDATE calendar_entries SET series_external_id = json_extract(metadata, '$.recurring_event_id')\n  WHERE kind = 'occurrence' AND json_valid(metadata) AND json_extract(metadata, '$.recurring_event_id') IS NOT NULL;",
      "UPDATE calendar_entries SET event_type = CASE event_type\n    WHEN 'outOfOffice' THEN 'out-of-office'\n    WHEN 'focusTime' THEN 'focus'\n    WHEN 'workingLocation' THEN 'working-location'\n    WHEN 'fromGmail' THEN 'from-mail'\n  END\n  WHERE event_type IN ('outOfOffice', 'focusTime', 'workingLocation', 'fromGmail');",
      "UPDATE calendar_entries SET own_response = 'needs-action' WHERE own_response = 'needsAction';",
      "UPDATE calendar_entry_participants SET response = 'needs-action' WHERE response = 'needsAction';",
      "UPDATE calendars SET access_role = 'free-busy' WHERE access_role = 'freeBusyReader';"
    ]
  },
  {
    "name": "20261029162435_version-36-attachment-contact",
    "statements": [
      "ALTER TABLE `attachments` ADD `contact` text;"
    ]
  },
  {
    "name": "20261029180959_version-37-identity-phone",
    "statements": [
      "ALTER TABLE `identities` ADD `phone` text;"
    ]
  },
  {
    "name": "20261029181000_version-37-contact-mention-triggers",
    "statements": [
      "-- A shared contact card has no text, only a phone: queue it for mentions like an attachment's text.\n-- Cards stored before version 37 wait for `mentions rebuild`.\nCREATE TRIGGER mention_pending_attachment_contact_ai AFTER INSERT ON attachments\n  WHEN new.attachable_type = 'message' AND new.contact IS NOT NULL BEGIN\n  INSERT OR IGNORE INTO mention_pending (source_type, source_id) VALUES ('attachment', new.id);\nEND;",
      "CREATE TRIGGER mention_pending_attachment_contact_au AFTER UPDATE OF contact ON attachments\n  WHEN new.attachable_type = 'message' AND old.contact IS NOT new.contact BEGIN\n  INSERT OR IGNORE INTO mention_pending (source_type, source_id) VALUES ('attachment', new.id);\nEND;"
    ]
  },
  {
    "name": "20261029224106_version-38-folded-names",
    "statements": [
      "ALTER TABLE `chats` ADD `title_folded` text;",
      "ALTER TABLE `email_threads` ADD `subject_folded` text;",
      "ALTER TABLE `identities` ADD `name_folded` text;",
      "ALTER TABLE `mailboxes` ADD `name_folded` text;",
      "ALTER TABLE `projects` ADD `name_folded` text;",
      "CREATE INDEX `chats_title_to_fold` ON `chats` (`id`) WHERE title IS NOT NULL AND title_folded IS NULL;",
      "CREATE INDEX `email_threads_subject_to_fold` ON `email_threads` (`id`) WHERE subject IS NOT NULL AND subject_folded IS NULL;",
      "CREATE INDEX `identities_name_to_fold` ON `identities` (`id`) WHERE name IS NOT NULL AND name_folded IS NULL;",
      "CREATE INDEX `mailboxes_by_name_folded` ON `mailboxes` (`name_folded`);",
      "CREATE INDEX `mailboxes_name_to_fold` ON `mailboxes` (`id`) WHERE name_folded IS NULL;",
      "CREATE INDEX `projects_by_name_folded` ON `projects` (`name_folded`);",
      "CREATE INDEX `projects_name_to_fold` ON `projects` (`id`) WHERE name_folded IS NULL;"
    ]
  },
  {
    "name": "20261029224107_version-38-folded-triggers",
    "statements": [
      "-- A build older than 38, or a write that forgets the copy, changes a name without its folded copy: empty the copy\n-- so the next open refills it (fillFolded) rather than leave a stale one that filters would trust.\nCREATE TRIGGER tasks_title_folded_au AFTER UPDATE OF title ON tasks\n  WHEN new.title IS NOT old.title AND new.title_folded IS old.title_folded BEGIN\n  UPDATE tasks SET title_folded = NULL WHERE id = new.id;\nEND;",
      "CREATE TRIGGER tasks_close_reason_folded_au AFTER UPDATE OF close_reason ON tasks\n  WHEN new.close_reason IS NOT old.close_reason AND new.close_reason_folded IS old.close_reason_folded BEGIN\n  UPDATE tasks SET close_reason_folded = NULL WHERE id = new.id;\nEND;",
      "CREATE TRIGGER attachments_name_folded_au AFTER UPDATE OF name ON attachments\n  WHEN new.name IS NOT old.name AND new.name_folded IS old.name_folded BEGIN\n  UPDATE attachments SET name_folded = NULL WHERE id = new.id;\nEND;",
      "CREATE TRIGGER attachments_local_path_folded_au AFTER UPDATE OF local_path ON attachments\n  WHEN new.local_path IS NOT old.local_path AND new.local_path_folded IS old.local_path_folded BEGIN\n  UPDATE attachments SET local_path_folded = NULL WHERE id = new.id;\nEND;",
      "CREATE TRIGGER meetings_title_folded_au AFTER UPDATE OF title ON meetings\n  WHEN new.title IS NOT old.title AND new.title_folded IS old.title_folded BEGIN\n  UPDATE meetings SET title_folded = NULL WHERE id = new.id;\nEND;",
      "CREATE TRIGGER files_path_folded_au AFTER UPDATE OF path ON files\n  WHEN new.path IS NOT old.path AND new.path_folded IS old.path_folded BEGIN\n  UPDATE files SET path_folded = NULL WHERE id = new.id;\nEND;",
      "CREATE TRIGGER projects_name_folded_au AFTER UPDATE OF name ON projects\n  WHEN new.name IS NOT old.name AND new.name_folded IS old.name_folded BEGIN\n  UPDATE projects SET name_folded = NULL WHERE id = new.id;\nEND;",
      "CREATE TRIGGER chats_title_folded_au AFTER UPDATE OF title ON chats\n  WHEN new.title IS NOT old.title AND new.title_folded IS old.title_folded BEGIN\n  UPDATE chats SET title_folded = NULL WHERE id = new.id;\nEND;",
      "CREATE TRIGGER identities_name_folded_au AFTER UPDATE OF name ON identities\n  WHEN new.name IS NOT old.name AND new.name_folded IS old.name_folded BEGIN\n  UPDATE identities SET name_folded = NULL WHERE id = new.id;\nEND;",
      "CREATE TRIGGER email_threads_subject_folded_au AFTER UPDATE OF subject ON email_threads\n  WHEN new.subject IS NOT old.subject AND new.subject_folded IS old.subject_folded BEGIN\n  UPDATE email_threads SET subject_folded = NULL WHERE id = new.id;\nEND;",
      "CREATE TRIGGER mailboxes_name_folded_au AFTER UPDATE OF name ON mailboxes\n  WHEN new.name IS NOT old.name AND new.name_folded IS old.name_folded BEGIN\n  UPDATE mailboxes SET name_folded = NULL WHERE id = new.id;\nEND;"
    ]
  },
  {
    "name": "20261030114008_version-39-email-locations",
    "statements": [
      "CREATE TABLE `email_locations` (\n\t`mailbox_id` integer NOT NULL,\n\t`uidvalidity` text NOT NULL,\n\t`uid` integer NOT NULL,\n\t`email_id` integer NOT NULL,\n\tCONSTRAINT `email_locations_pk` PRIMARY KEY(`mailbox_id`, `uidvalidity`, `uid`),\n\tCONSTRAINT `fk_email_locations_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`),\n\tCONSTRAINT `fk_email_locations_email_id_emails_id_fk` FOREIGN KEY (`email_id`) REFERENCES `emails`(`id`)\n);",
      "CREATE INDEX `email_locations_by_email_id` ON `email_locations` (`email_id`);"
    ]
  },
  {
    "name": "20261030225520_version-40-note-trigrams",
    "statements": [
      "CREATE VIRTUAL TABLE note_trigrams USING fts5(text, content = '', contentless_delete = 1, tokenize = 'trigram');",
      "CREATE VIRTUAL TABLE document_trigrams USING fts5(text, content = '', contentless_delete = 1, tokenize = 'trigram');",
      "CREATE TRIGGER note_trigrams_bd BEFORE DELETE ON notes BEGIN\n  DELETE FROM note_trigrams WHERE rowid = old.id;\nEND;",
      "CREATE TRIGGER document_trigrams_bd BEFORE DELETE ON documents BEGIN\n  DELETE FROM document_trigrams WHERE rowid = old.id;\nEND;",
      "-- The trigrams hold JS-normalized text, which SQL cannot produce: fillTrigrams fills the rows stored before this\n-- version, up to `watermark`, and a search reads the rest of them by their text meanwhile.\nINSERT INTO search_index_state (name, watermark, filled_through, terms_through, normalizer_version)\n  SELECT 'note_trigrams', coalesce(max(id), 0), 0, 0, 1 FROM notes\n  UNION ALL SELECT 'document_trigrams', coalesce(max(id), 0), 0, 0, 1 FROM documents;"
    ]
  },
  {
    "name": "20261031230945_version-41-task-fields",
    "statements": [
      "ALTER TABLE `tasks` ADD `priority_score` real;",
      "ALTER TABLE `tasks` ADD `agent` text;",
      "ALTER TABLE `tasks` ADD `revision` integer DEFAULT 1 NOT NULL;",
      "-- 0 urgent … 4 low land inside the critical, high, medium and low quarters, with room on either side for moves.\nUPDATE tasks SET priority_score = CASE priority WHEN 0 THEN 0.875 WHEN 1 THEN 0.625 WHEN 2 THEN 0.375 WHEN 3 THEN 0.1875 WHEN 4 THEN 0.0625 END WHERE priority IS NOT NULL;",
      "-- A build before version 41 writes only `priority`; these keep the score in step with what it wrote.\nCREATE TRIGGER tasks_priority_score_ai AFTER INSERT ON tasks WHEN new.priority IS NOT NULL AND new.priority_score IS NULL BEGIN\n  UPDATE tasks SET priority_score = CASE new.priority WHEN 0 THEN 0.875 WHEN 1 THEN 0.625 WHEN 2 THEN 0.375 WHEN 3 THEN 0.1875 WHEN 4 THEN 0.0625 END WHERE id = new.id;\nEND;",
      "CREATE TRIGGER tasks_priority_score_au AFTER UPDATE OF priority ON tasks WHEN new.priority IS NOT old.priority AND new.priority_score IS old.priority_score BEGIN\n  UPDATE tasks SET priority_score = CASE new.priority WHEN 0 THEN 0.875 WHEN 1 THEN 0.625 WHEN 2 THEN 0.375 WHEN 3 THEN 0.1875 WHEN 4 THEN 0.0625 END WHERE id = new.id;\nEND;",
      "-- Every build's write bumps it, older ones too, so a stale copy is caught whoever wrote last.\nCREATE TRIGGER tasks_revision_au AFTER UPDATE ON tasks WHEN new.revision IS old.revision BEGIN\n  UPDATE tasks SET revision = old.revision + 1 WHERE id = new.id;\nEND;"
    ]
  },
  {
    "name": "20261101002523_version-42-task-revision",
    "statements": [
      "-- A claim renewed, a follow-up time or a close suggestion is an agent at work, not a change a person could overwrite;\n-- bumping on those made the board report a conflict while an agent simply worked.\nDROP TRIGGER tasks_revision_au;",
      "CREATE TRIGGER tasks_revision_au AFTER UPDATE OF title, description, status, priority, priority_score, agent, due_at, project_id, parent_id ON tasks\n  WHEN new.revision IS old.revision AND (new.title IS NOT old.title OR new.description IS NOT old.description\n    OR new.status IS NOT old.status OR new.priority IS NOT old.priority OR new.priority_score IS NOT old.priority_score\n    OR new.agent IS NOT old.agent OR new.due_at IS NOT old.due_at OR new.project_id IS NOT old.project_id\n    OR new.parent_id IS NOT old.parent_id) BEGIN\n  UPDATE tasks SET revision = old.revision + 1 WHERE id = new.id;\nEND;",
      "CREATE TRIGGER tasks_revision_assignment_ai AFTER INSERT ON task_assignments BEGIN\n  UPDATE tasks SET revision = revision + 1 WHERE id = new.task_id;\nEND;",
      "CREATE TRIGGER tasks_revision_assignment_ad AFTER DELETE ON task_assignments BEGIN\n  UPDATE tasks SET revision = revision + 1 WHERE id = old.task_id;\nEND;",
      "CREATE TRIGGER tasks_revision_tagging_ai AFTER INSERT ON taggings WHEN new.taggable_type = 'task' BEGIN\n  UPDATE tasks SET revision = revision + 1 WHERE id = new.taggable_id;\nEND;",
      "CREATE TRIGGER tasks_revision_tagging_ad AFTER DELETE ON taggings WHEN old.taggable_type = 'task' BEGIN\n  UPDATE tasks SET revision = revision + 1 WHERE id = old.taggable_id;\nEND;"
    ]
  },
  {
    "name": "20261101011859_version-43-memory-project",
    "statements": [
      "ALTER TABLE `memories` ADD `project_id` integer REFERENCES projects(id);",
      "CREATE INDEX `memories_by_project_id` ON `memories` (`project_id`);"
    ]
  }
]
