resource "aws_security_group" "fit_cli_vpc_endpoints" {
  name        = "fit-cli-vpc-endpoints"
  description = "Allows instances in the fit-cli VPC to reach the SSM interface endpoints"
  vpc_id      = aws_vpc.fit_cli.id

  ingress {
    description = "HTTPS from the fit-cli VPC"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [local.fit_cli_vpc_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "fit-cli-vpc-endpoints"
  }
}

locals {
  fit_cli_ssm_endpoint_services = ["ssm", "ssmmessages", "ec2messages"]
}

resource "aws_vpc_endpoint" "fit_cli_ssm" {
  for_each = toset(local.fit_cli_ssm_endpoint_services)

  vpc_id              = aws_vpc.fit_cli.id
  service_name        = "com.amazonaws.us-west-2.${each.value}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [aws_subnet.fit_cli_public.id]
  security_group_ids  = [aws_security_group.fit_cli_vpc_endpoints.id]
  private_dns_enabled = true

  tags = {
    Name = "fit-cli-${each.value}"
  }
}

# Lets instances pull from S3 without that traffic leaving the AWS backbone.
resource "aws_vpc_endpoint" "fit_cli_s3" {
  vpc_id            = aws_vpc.fit_cli.id
  service_name      = "com.amazonaws.us-west-2.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.fit_cli_public.id]

  tags = {
    Name = "fit-cli-s3"
  }
}
