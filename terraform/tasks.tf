resource "google_cloud_tasks_queue" "dispatch" {
  name     = "kinglet-validation-dispatch-queue"
  location = var.region

  rate_limits {
    max_concurrent_dispatches = 3
  }
}
