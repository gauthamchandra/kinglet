variable "subscription_delivery" {
  description = "Delivery mode for the convertible subscription. Used to exercise push-to-pull without recreating the resource."
  type        = string
  default     = "pull"

  validation {
    condition     = contains(["pull", "push"], var.subscription_delivery)
    error_message = "subscription_delivery must be pull or push."
  }
}

resource "google_pubsub_topic" "events" {
  name = "kinglet-validation-events-topic"

  labels = {
    env = "kinglet"
  }
}

resource "google_pubsub_topic" "events_dead_letter" {
  name = "kinglet-validation-events-dead-letter"
}

resource "google_pubsub_subscription" "events_pull" {
  name  = "kinglet-validation-events-subscription"
  topic = google_pubsub_topic.events.name

  ack_deadline_seconds       = 20
  message_retention_duration = "604800s"
  retain_acked_messages      = false

  labels = {
    env = "kinglet"
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.events_dead_letter.id
    max_delivery_attempts = 10
  }
}

resource "google_pubsub_subscription" "events_push" {
  name  = "kinglet-validation-events-push"
  topic = google_pubsub_topic.events.name

  ack_deadline_seconds = 20

  push_config {
    push_endpoint = "https://example.com/kinglet-validation-push"

    attributes = {
      x-goog-version = "v1"
    }
  }
}

resource "google_pubsub_subscription" "events_convertible" {
  name  = "kinglet-validation-events-convertible"
  topic = google_pubsub_topic.events.name

  ack_deadline_seconds = 20

  dynamic "push_config" {
    for_each = var.subscription_delivery == "push" ? [1] : []

    content {
      push_endpoint = "https://example.com/kinglet-validation-convertible"

      attributes = {
        x-goog-version = "v1"
      }
    }
  }
}
