output "fit_cli_role_arn" {
  value = aws_iam_role.fit_cli_role.arn
}

output "fit_cli_vpc_id" {
  description = "Paste into environments.json5 -> defaults.aws.vpcId"
  value       = aws_vpc.fit_cli.id
}

output "fit_cli_default_security_group_id" {
  description = "Paste into environments.json5 -> defaults.aws.privateEndpointVpcSgId"
  value       = aws_default_security_group.fit_cli.id
}

output "fit_cli_subnet_id" {
  description = "Paste into environments.json5 -> defaults.aws.subnetId"
  value       = aws_subnet.fit_cli_public.id
}

output "ssm_instance_profile_name" {
  description = "Paste into environments.json5 -> defaults.aws.ssmInstanceProfileName"
  value       = aws_iam_instance_profile.fit_cli_ssm_instance_profile.name
}
