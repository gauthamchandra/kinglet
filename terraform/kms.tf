resource "google_kms_key_ring" "encryption" {
  name     = "kinglet-validation-encryption-keyring"
  location = var.region
}

resource "google_kms_crypto_key" "encryption" {
  name     = "kinglet-validation-encryption-key"
  key_ring = google_kms_key_ring.encryption.id

  version_template {
    algorithm = "GOOGLE_SYMMETRIC_ENCRYPTION"
  }
}
