resource "google_pubsub_topic" "events" {
  name = "kinglet-validation-events-topic"
}

resource "google_pubsub_subscription" "events_pull" {
  name  = "kinglet-validation-events-subscription"
  topic = google_pubsub_topic.events.name

  ack_deadline_seconds = 20

  # Match GCP default so read-after-create does not drift.
  expiration_policy {
    ttl = "2678400s"
  }
}
