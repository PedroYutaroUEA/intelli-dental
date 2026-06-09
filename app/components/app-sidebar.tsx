"use client";

import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { auth } from "@/lib/api-client";
import { useActiveClinic } from "@/lib/use-active-clinic";
import {
  Building2,
  Calendar,
  ClipboardList,
  LayoutDashboard,
  LogOut,
  Sparkles,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

const menuItems = [
  { title: "Painel", icon: LayoutDashboard, href: "/dashboard" },
  { title: "Pacientes", icon: Users, href: "/clients" },
  { title: "Assistente", icon: Sparkles, href: "/assistant" },
  { title: "Agendamentos", icon: Calendar, href: "/agendamentos" },
  { title: "Minha Agenda", icon: ClipboardList, href: "/minha-agenda" },
];

export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { clinic, loading } = useActiveClinic();

  const handleLogout = (e: React.MouseEvent) => {
    e.preventDefault();
    auth.clear();
    router.push("/login");
  };

  return (
    <Sidebar>
      <SidebarHeader className="border-b border-sidebar-border p-4">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-sidebar-primary flex items-center justify-center">
            <span className="text-sidebar-primary-foreground font-bold">D</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sidebar-foreground text-sm">
              Intelli Dental
            </p>
            <p className="text-xs text-sidebar-foreground/60 truncate">
              {loading ? "Carregando..." : (clinic?.name ?? "Sem clínica")}
            </p>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navegação</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {menuItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild isActive={pathname === item.href}>
                    <Link href={item.href}>
                      <item.icon className="w-4 h-4" />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border p-4">
        <div className="space-y-2">
          <Link href="/companies">
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-start bg-transparent"
            >
              <Building2 className="w-4 h-4 mr-2" />
              Trocar Empresa
            </Button>
          </Link>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-destructive hover:text-destructive"
            onClick={handleLogout}
          >
            <LogOut className="w-4 h-4 mr-2" />
            Sair
          </Button>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
