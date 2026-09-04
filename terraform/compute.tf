resource "google_compute_security_policy" "example" {
  name        = "kinglet-validation-policy"
  description = "Cloud Armor validation: path deny + default allow"

  rule {
    action   = "deny(403)"
    priority = 1000

    match {
      expr {
        expression = "request.path.startsWith('/admin')"
      }
    }
  }

  rule {
    action   = "allow"
    priority = 2147483647

    match {
      versioned_expr = "SRC_IPS_V1"

      config {
        src_ip_ranges = ["*"]
      }
    }
  }
}
