import caroLogo from "@/assets/caro-logo.png";

const Footer = () => {
  return (
    <footer className="border-t border-border bg-card mt-auto">
      <div className="container mx-auto px-4 py-6">
        <div className="flex items-center gap-4">
          <img 
            src={caroLogo} 
            alt="Caro Logo" 
            className="h-16 w-auto object-contain"
          />
          <p className="text-sm text-muted-foreground">
            Sponsored by Caro Garten- und Landschaftsbau
          </p>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
