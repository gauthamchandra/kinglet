resource "google_cloud_scheduler_job" "http_callback" {
  name     = "kinglet-validation-http-job"
  region   = var.region
  schedule = "0 9 * * 1"

  http_target {
    uri         = "https://example.com/kinglet-validation"
    http_method = "POST"
  }

  retry_config {
    retry_count          = 0
    max_retry_duration   = "0s"
    min_backoff_duration = "5s"
    max_backoff_duration = "3600s"
    max_doublings        = 5
  }
}

resource "google_cloud_scheduler_job" "pubsub_publish" {
  name     = "kinglet-validation-pubsub-job"
  region   = var.region
  schedule = "0 10 * * 1"

  pubsub_target {
    topic_name = google_pubsub_topic.events.id
    data       = base64encode("kinglet-terraform-validation")
  }

  retry_config {
    retry_count          = 0
    max_retry_duration   = "0s"
    min_backoff_duration = "5s"
    max_backoff_duration = "3600s"
    max_doublings        = 5
  }
}
