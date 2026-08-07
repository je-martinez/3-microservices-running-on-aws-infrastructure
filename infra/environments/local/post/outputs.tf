# Exposed so `make assets-sync` can DISCOVER the bucket and its public base URL
# rather than hardcoding either. The bucket name is derived from a label and the
# base URL from the endpoint style, so both are already knowable — but reading
# them from state is what keeps the standalone target correct after a rename or
# a switch to CloudFront, instead of quietly uploading to the wrong place.
output "assets_bucket_name" {
  description = "Name of the public assets bucket."
  value       = module.assets_bucket.bucket_name
}

output "assets_base_url" {
  description = "Public base URL for the assets bucket; an object key is appended to it."
  value       = module.assets_bucket.public_base_url
}
