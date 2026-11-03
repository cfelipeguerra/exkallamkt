export interface Client {
  id: number;
  name: string;
  slug: string;
  whatsapp_number: string;
  evolution_instance: string;
  webhook_token: string;
  report_token: string;
  api_token: string;
  currency: string;
  default_sale_value: number;
  sale_keywords: string;
  sale_labels: string;
  qualified_labels: string;
  send_lead_event: number;
  invisible_ref: number;
  meta_pixel_id: string | null;
  meta_access_token: string | null; // criptografado
  meta_test_event_code: string | null;
  meta_waba_id: string | null;
  ga4_measurement_id: string | null;
  ga4_api_secret: string | null; // criptografado
  gads_customer_id: string | null;
  gads_purchase_action_id: string | null;
  gads_lead_action_id: string | null;
  gads_purchase_action_name: string | null;
  gads_lead_action_name: string | null;
  active: number;
  last_webhook_at: number | null;
  created_at: number;
}

export interface TrackingLink {
  id: number;
  client_id: number;
  slug: string;
  name: string;
  message: string;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  created_at: number;
}

export interface Click {
  id: number;
  client_id: number;
  link_id: number | null;
  ref_code: string;
  origin: 'link' | 'tag';
  fbclid: string | null;
  fbc: string | null;
  fbp: string | null;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
  ga_client_id: string | null;
  ga_session_id: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  page_url: string | null;
  referrer: string | null;
  ip: string | null;
  user_agent: string | null;
  matched_contact_id: number | null;
  created_at: number;
}

export type ContactSource = 'ctwa' | 'link' | 'tag' | 'organic';
export type ContactStatus = 'lead' | 'qualified' | 'customer';

export interface Contact {
  id: number;
  client_id: number;
  phone: string;
  jid: string | null;
  lid: string | null;
  push_name: string | null;
  source: ContactSource;
  click_id: number | null;
  ctwa_clid: string | null;
  ad_source_id: string | null;
  ad_source_url: string | null;
  ad_title: string | null;
  ad_source_app: string | null;
  status: ContactStatus;
  last_quoted_value: number | null;
  messages_in: number;
  messages_out: number;
  first_message_at: number;
  last_message_at: number;
}

export interface Sale {
  id: number;
  client_id: number;
  contact_id: number;
  value: number;
  currency: string;
  detected_by: 'manual' | 'keyword' | 'label' | 'api';
  external_ref: string | null;
  note: string | null;
  created_at: number;
}

export type EventKind = 'lead' | 'qualified' | 'purchase';
export type Platform = 'meta' | 'ga4' | 'gads';

export interface TrackEvent {
  id: number;
  client_id: number;
  contact_id: number | null;
  sale_id: number | null;
  kind: EventKind;
  platform: Platform;
  event_id: string;
  status: 'pending' | 'sent' | 'error' | 'skipped';
  attempts: number;
  next_attempt_at: number;
  event_time: number;
  detail: string | null;
  request: string | null;
  response: string | null;
  created_at: number;
  sent_at: number | null;
}
