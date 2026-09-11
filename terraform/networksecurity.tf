resource "google_network_security_address_group" "cloud_armor" {
  provider = google-beta

  name        = "kinglet-validation-web-allow"
  parent      = "projects/${var.project_id}"
  location    = "global"
  type        = "IPV4"
  capacity    = "100"
  purpose     = ["CLOUD_ARMOR"]
  items       = ["198.51.100.0/24", "203.0.113.10"]
  description = "kinglet terraform validation address group"
}
