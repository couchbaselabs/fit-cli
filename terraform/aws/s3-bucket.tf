# The fit-cli results/artifacts bucket. Originally created out-of-band; now
# imported and managed here so its config (lifecycle rules etc.) is in code.
resource "aws_s3_bucket" "fit_cli" {
  bucket = "fit-cli"
}

resource "aws_s3_bucket_lifecycle_configuration" "fit_cli" {
  bucket = aws_s3_bucket.fit_cli.id

  rule {
    id     = "expire-run-artifacts"
    status = "Enabled"

    filter {
      prefix = "runs/"
    }

    expiration {
      days = 180
    }
  }

  rule {
    id     = "expire-ssm-relay"
    status = "Enabled"

    filter {
      prefix = "ssm-relay/"
    }

    expiration {
      days = 1
    }
  }
}

# Nothing in fit-cli needs public access: everything goes through IAM, and the
# SSM relay's presigned URLs are unaffected by these blocks.
resource "aws_s3_bucket_public_access_block" "fit_cli" {
  bucket = aws_s3_bucket.fit_cli.id

  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}
